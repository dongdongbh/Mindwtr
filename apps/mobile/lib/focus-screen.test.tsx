import React from 'react';
import { Alert, AppState, Modal, SectionList, Text, TextInput, View } from 'react-native';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppData, AppSettings, Project, StorageAdapter, Task } from '@mindwtr/core';

import FocusScreen from '../app/(drawer)/(tabs)/focus';
import { SwipeableTaskItem } from '@/components/swipeable-task-item';

const showToastMock = vi.hoisted(() => vi.fn());
const openProjectScreenMock = vi.hoisted(() => vi.fn());
const asyncStorageMock = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
}));
const hapticsMock = vi.hoisted(() => ({
  impactAsync: vi.fn().mockResolvedValue(undefined),
  selectionAsync: vi.fn().mockResolvedValue(undefined),
}));
const dragMock = vi.hoisted(() => vi.fn());
const backHandlerMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/hardware-back', () => ({
  addHardwareBackPressListener: backHandlerMock,
}));

const makeTask = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  status: 'next',
  tags: [],
  contexts: [],
  createdAt: '2026-04-01T00:00:00.000Z',
  updatedAt: '2026-04-01T00:00:00.000Z',
  ...overrides,
});

const makeProject = (id: string, overrides: Partial<Project> = {}): Project => ({
  id,
  title: `Project ${id}`,
  status: 'active',
  color: '#3b82f6',
  order: 0,
  tagIds: [],
  createdAt: '2026-04-01T00:00:00.000Z',
  updatedAt: '2026-04-01T00:00:00.000Z',
  ...overrides,
});

const storeState: {
  tasks: Task[];
  projects: Project[];
  settings: AppSettings;
  updateTask: ReturnType<typeof vi.fn>;
  deleteTask: ReturnType<typeof vi.fn>;
  reorderFocusedTasks: ReturnType<typeof vi.fn>;
  updateSettings: ReturnType<typeof vi.fn>;
  highlightTaskId: string | null;
  setHighlightTask: ReturnType<typeof vi.fn>;
} = {
  tasks: [
    makeTask('focus-task', { isFocusedToday: true, dueDate: '2000-01-01' }),
    makeTask('next-task'),
  ],
  projects: [],
  settings: { appearance: {}, features: {} },
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  reorderFocusedTasks: vi.fn(),
  updateSettings: vi.fn(),
  highlightTaskId: null,
  setHighlightTask: vi.fn(),
};

const createDeferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const createImmediatePromise = <T,>(value: T): Promise<T> => ({
  then: (onFulfilled) => Promise.resolve(onFulfilled ? onFulfilled(value) : value),
  catch: () => Promise.resolve(value),
  finally: () => Promise.resolve(value),
  [Symbol.toStringTag]: 'Promise',
}) as Promise<T>;

beforeEach(() => {
  storeState.tasks = [
    makeTask('focus-task', { isFocusedToday: true, dueDate: '2000-01-01' }),
    makeTask('next-task'),
  ];
  storeState.projects = [];
  storeState.settings = { appearance: {}, features: {} };
  storeState.updateTask.mockReset();
  storeState.updateTask.mockResolvedValue({ success: true });
  storeState.deleteTask.mockClear();
  storeState.reorderFocusedTasks.mockReset();
  storeState.reorderFocusedTasks.mockResolvedValue({ success: true });
  storeState.updateSettings.mockClear();
  storeState.highlightTaskId = null;
  showToastMock.mockClear();
  openProjectScreenMock.mockClear();
  asyncStorageMock.getItem.mockReset();
  asyncStorageMock.getItem.mockReturnValue(createImmediatePromise<string | null>(null));
  asyncStorageMock.setItem.mockReset();
  asyncStorageMock.setItem.mockResolvedValue(undefined);
  hapticsMock.impactAsync.mockClear();
  hapticsMock.selectionAsync.mockClear();
  dragMock.mockClear();
  backHandlerMock.mockReset();
  backHandlerMock.mockReturnValue({ remove: vi.fn() });
});

afterEach(() => {
  vi.useRealTimers();
});

vi.mock('@mindwtr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mindwtr/core')>();
  // The real store is selector-based; the shared visible-task context
  // subscribes field by field, so the mock has to honour selectors.
  const useTaskStore = Object.assign(
    (selector?: (state: typeof storeState) => unknown) => (selector ? selector(storeState) : storeState),
    { getState: () => storeState },
  );

  return {
    ...actual,
    getUsedTaskTokens: (tasks: Task[], selector: (task: Task) => string[]) => {
      const tokens = new Set<string>();
      tasks.forEach((task) => {
        selector(task).forEach((token) => {
          if (token) tokens.add(token);
        });
      });
      return Array.from(tokens).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    },
    useTaskStore,
  };
});

vi.mock('react-native-draggable-flatlist', async () => {
  const ReactModule = await import('react');
  return {
    __esModule: true,
    ScaleDecorator: ({ children, ...props }: any) => ReactModule.createElement('ScaleDecorator', props, children),
    default: (props: any) => ReactModule.createElement(
      'DraggableFlatList',
      props,
      (props.data ?? []).map((item: any, index: number) =>
        ReactModule.createElement(
          ReactModule.Fragment,
          { key: props.keyExtractor(item) },
          props.renderItem({ item, drag: dragMock, isActive: false, getIndex: () => index }),
        )),
    ),
  };
});

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: hapticsMock.impactAsync,
  selectionAsync: hapticsMock.selectionAsync,
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: asyncStorageMock,
}));

vi.mock('../contexts/theme-context', () => ({
  useTheme: () => ({ isDark: false }),
}));

vi.mock('../contexts/language-context', () => {
  // One stable `t`, as the real provider gives: its context value only changes
  // when the language does, so a store write must not churn translator
  // identity — several Focus callbacks memoise on it.
  const t = (key: string) =>
    ({
        'common.all': 'All',
        'agenda.todaysFocus': "Today's Focus",
        'focus.schedule': 'Today',
        'focus.nextActions': 'Next Actions',
        'agenda.upcoming': 'Upcoming',
        'agenda.reviewDue': 'Review Due',
        'agenda.reviewDueProjects': 'Projects to review',
        'agenda.allClear': 'All clear',
        'agenda.noTasks': 'No tasks',
        'review.markReviewed': 'Mark reviewed',
        'status.active': 'Active',
        'energyLevel.high': 'High energy',
        'filters.label': 'Filters',
        'savedFilters.save': 'Save',
        'projects.reorderTasks': 'Reorder',
        'focus.reorderPosition': '{{title}}. Item {{position}} of {{count}}',
        'focus.reorderHint': 'Hold and drag to reorder',
        'common.done': 'Done',
        'taskEdit.locationLabel': 'Location',
        'taskEdit.locationPlaceholder': 'e.g. Office',
      }[key] ?? key);
  return { useLanguage: () => ({ t }) };
});

vi.mock('../contexts/toast-context', () => ({
  ToastViewport: () => null,
  useToast: () => ({
    showToast: showToastMock,
    dismissToast: vi.fn(),
  }),
}));

vi.mock('@/lib/sync-service', () => ({
  getMobileSyncConfigurationStatus: vi.fn().mockResolvedValue({ backend: 'off', configured: false }),
  performMobileSync: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('@react-native-community/datetimepicker', () => ({
  default: (props: any) => React.createElement('DateTimePicker', props),
}));

vi.mock('@/hooks/use-theme-tokens', () => ({
  useThemeTokens: () => ({ isMaterial: false, roles: null, shape: { large: 16 } }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#0f172a',
    cardBg: '#111827',
    taskItemBg: '#111827',
    inputBg: '#111827',
    filterBg: '#1f2937',
    border: '#334155',
    text: '#f8fafc',
    secondaryText: '#94a3b8',
    icon: '#94a3b8',
    tint: '#3b82f6',
    onTint: '#ffffff',
    tabIconDefault: '#94a3b8',
    tabIconSelected: '#3b82f6',
    danger: '#ef4444',
    success: '#10b981',
    warning: '#f59e0b',
  }),
}));

vi.mock('@/components/swipeable-task-item', () => ({
  SwipeableTaskItem: (props: any) => React.createElement('SwipeableTaskItem', props),
}));

vi.mock('@/components/task-edit-modal', () => ({
  TaskEditModal: (props: any) => React.createElement('TaskEditModal', props),
}));

vi.mock('@/components/pomodoro-panel', () => ({
  PomodoroPanel: (props: any) => React.createElement('PomodoroPanel', props),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 24, left: 0 }),
}));

vi.mock('@/hooks/use-mobile-area-filter', () => ({
  useMobileAreaFilter: () => ({ areaById: new Map(), resolvedAreaFilter: { included: [], excluded: [] } }),
}));

vi.mock('@/lib/task-meta-navigation', () => ({
  openContextsScreen: vi.fn(),
  openProjectScreen: openProjectScreenMock,
}));

function textContent(node: any): string {
  return node.children
    .map((child: any) => (typeof child === 'string' ? child : textContent(child)))
    .join('');
}

function findButtonByText(
  tree: ReturnType<typeof create>,
  text: string,
  options: { last?: boolean; root?: ReactTestInstance } = {},
) {
  const matches = (options.root ?? tree.root).findAll((node) =>
    node.props.accessibilityRole === 'button'
    && typeof node.props.onPress === 'function'
    && textContent(node).includes(text)
  );
  if (matches.length === 0) {
    throw new Error(`No button found with text: ${text}`);
  }
  return options.last ? matches[matches.length - 1] : matches[0];
}

function findButtonByLabel(tree: ReturnType<typeof create>, label: string, options: { last?: boolean } = {}) {
  const matches = tree.root.findAll((node) =>
    node.props.accessibilityRole === 'button'
    && node.props.accessibilityLabel === label
    && typeof node.props.onPress === 'function'
  );
  if (matches.length === 0) {
    throw new Error(`No button found with label: ${label}`);
  }
  return options.last ? matches[matches.length - 1] : matches[0];
}

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>((result, item) => ({
      ...result,
      ...flattenStyle(item),
    }), {});
  }
  return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

describe('FocusScreen', () => {
  it('renders starred tasks in a dedicated Today\'s Focus section', () => {
    storeState.tasks = [
      makeTask('plain-next', { title: 'Plain next' }),
      makeTask('focused-next', { title: 'Focused next', isFocusedToday: true }),
      makeTask('another-next', { title: 'Another next' }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id),
    ).toEqual(['focused-next', 'another-next', 'plain-next']);

    const focusedRow = tree.root.findAllByType(SwipeableTaskItem)
      .find((node) => node.props.task.id === 'focused-next');
    expect(focusedRow?.props.showFocusHighlight).toBe(false);

    expect(() =>
      tree.root.find((node) =>
        node.props.accessibilityLabel === "Today's Focus" && typeof node.props.onPress === 'function'
      )
    ).not.toThrow();
  });

  it('invalidates the Focus list and removes a row after marking it done', async () => {
    storeState.tasks = [
      makeTask('focus-task', { title: 'Focused task', isFocusedToday: true }),
      makeTask('stale-next', { title: 'Stale next action' }),
      makeTask('plain-next', { title: 'Plain next' }),
    ];
    storeState.updateTask.mockImplementation(async (taskId: string, updates: Partial<Task>) => {
      storeState.tasks = storeState.tasks.map((task) => (
        task.id === taskId
          ? {
            ...task,
            ...updates,
            ...(updates.status === 'done' ? { isFocusedToday: false } : {}),
          }
          : task
      ));
      return { success: true };
    });

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    const initialListVersion = tree.root.findByType(SectionList).props.extraData;
    const row = tree.root.findAllByType(SwipeableTaskItem).find((node) => node.props.task.id === 'stale-next');
    expect(row).toBeTruthy();

    await act(async () => {
      await row?.props.actions.changeStatus(row.props.task, 'done');
    });
    act(() => {
      tree.update(<FocusScreen />);
    });

    expect(storeState.updateTask).toHaveBeenCalledWith('stale-next', { status: 'done' });
    expect(tree.root.findByType(SectionList).props.extraData).not.toEqual(initialListVersion);
    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id),
    ).toEqual(['focus-task', 'plain-next']);
  });

  it('uses a transparent refresh control for manual pull sync', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    const list = tree.root.findByType(SectionList);
    const refreshControl = list.props.refreshControl;

    expect(refreshControl.props.refreshing).toBe(false);
    expect(refreshControl.props.tintColor).toBe('transparent');
    expect(refreshControl.props.colors).toEqual(['transparent']);
    expect(refreshControl.props.progressBackgroundColor).toBe('transparent');
    expect(typeof refreshControl.props.onRefresh).toBe('function');
  });

  it('renders projects due for review and opens the project screen', () => {
    storeState.tasks = [];
    storeState.projects = [
      makeProject('review-project', {
        title: 'Quarterly planning',
        reviewAt: '2026-03-30T09:00:00.000Z',
      }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    expect(textContent(tree.root)).toContain('Projects to review');

    const projectButton = findButtonByText(tree, 'Quarterly planning');
    act(() => {
      projectButton.props.onPress();
    });

    expect(openProjectScreenMock).toHaveBeenCalledWith('review-project');
  });

  it('defers a focused task from the row action and offers undo', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 2, 10, 0, 0, 0));
    const alertSpy = vi.spyOn(Alert, 'alert');
    storeState.tasks = [
      makeTask('focused-next', {
        title: 'Focused next',
        isFocusedToday: true,
      }),
      makeTask('plain-next', { title: 'Plain next' }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    const focusedRow = tree.root.findAllByType(SwipeableTaskItem).find((node) => node.props.task.id === 'focused-next');
    expect(focusedRow?.props.onLongPressAction).toBeTypeOf('function');

    act(() => {
      focusedRow?.props.onLongPressAction(focusedRow.props.task);
    });

    const buttons = alertSpy.mock.calls[0]?.[2] as Array<{ text?: string; onPress?: () => void }>;
    const tomorrow = buttons.find((button) => button.text === 'Tomorrow');
    expect(tomorrow?.onPress).toBeTypeOf('function');

    await act(async () => {
      tomorrow?.onPress?.();
      await Promise.resolve();
    });

    expect(storeState.updateTask).toHaveBeenCalledWith('focused-next', {
      startTime: '2026-05-03',
      isFocusedToday: false,
    });
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Focused next',
      actionLabel: 'Undo',
      onAction: expect.any(Function),
    }));

    const toast = showToastMock.mock.calls[0]?.[0] as { onAction?: () => Promise<void> | void };
    await act(async () => {
      await toast.onAction?.();
    });

    expect(storeState.updateTask).toHaveBeenLastCalledWith('focused-next', {
      startTime: undefined,
      isFocusedToday: true,
    });
    vi.useRealTimers();
  });

  it('defers an unstarred next action without writing a focus flag', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 2, 10, 0, 0, 0));
    const alertSpy = vi.spyOn(Alert, 'alert');
    storeState.tasks = [
      makeTask('plain-next', { title: 'Plain next' }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    const row = tree.root.findAllByType(SwipeableTaskItem).find((node) => node.props.task.id === 'plain-next');
    expect(row?.props.onLongPressAction).toBeTypeOf('function');

    act(() => {
      row?.props.onLongPressAction(row.props.task);
    });

    const buttons = alertSpy.mock.calls[0]?.[2] as Array<{ text?: string; onPress?: () => void }>;
    const nextWeek = buttons.find((button) => button.text === 'Next week');
    expect(nextWeek?.onPress).toBeTypeOf('function');

    await act(async () => {
      nextWeek?.onPress?.();
      await Promise.resolve();
    });

    expect(storeState.updateTask).toHaveBeenCalledWith('plain-next', {
      startTime: '2026-05-09',
    });

    const toast = showToastMock.mock.calls[0]?.[0] as { onAction?: () => Promise<void> | void };
    await act(async () => {
      await toast.onAction?.();
    });

    expect(storeState.updateTask).toHaveBeenLastCalledWith('plain-next', {
      startTime: undefined,
    });
    vi.useRealTimers();
  });

  it('does not offer defer on due-dated Focus rows', () => {
    storeState.tasks = [
      makeTask('due-next', {
        title: 'Due next',
        dueDate: '2000-01-01',
      }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    const row = tree.root.findAllByType(SwipeableTaskItem).find((node) => node.props.task.id === 'due-next');
    expect(row?.props.onLongPressAction).toBeUndefined();
    expect(row?.props.onLongPressActionLabel).toBeUndefined();
  });

  it('bounds SectionList rendering for larger Focus lists', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    const list = tree.root.findByType(SectionList);
    expect(list.props.initialNumToRender).toBe(12);
    expect(list.props.maxToRenderPerBatch).toBe(12);
    expect(list.props.windowSize).toBe(5);
    expect(list.props.removeClippedSubviews).toBe(false);
  });

  it('keeps Focus content clear of the custom bottom tab bar', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    const list = tree.root.findByType(SectionList);
    expect(list.props.contentContainerStyle).toEqual(
      expect.arrayContaining([expect.objectContaining({ paddingBottom: 174 })])
    );
    expect(list.props.scrollIndicatorInsets).toEqual(expect.objectContaining({ bottom: 174 }));
  });

  it('uses a compact lead-in before the first visible Focus section', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    const todayHeader = findButtonByLabel(tree, "Today's Focus");
    const nextHeader = findButtonByLabel(tree, 'Next Actions');

    expect(flattenStyle(todayHeader.props.style).marginTop).toBe(8);
    expect(flattenStyle(nextHeader.props.style).marginTop).toBe(18);
  });

  it('lets Focus section titles shrink before the divider line truncates them', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    const todayText = tree.root.findAllByType(Text).find((node) => textContent(node) === "Today's Focus");
    expect(todayText).toBeDefined();
    expect(flattenStyle(todayText!.props.style)).toMatchObject({
      flexShrink: 1,
      minWidth: 0,
    });
  });

  it('keeps the Focus filter affordance compact without visible circle chrome', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    const filterButton = findButtonByLabel(tree, 'Filters');
    const rawStyle = typeof filterButton.props.style === 'function'
      ? filterButton.props.style({ pressed: false })
      : filterButton.props.style;
    const style = flattenStyle(rawStyle);

    expect(style.width).toBe(44);
    expect(style.height).toBe(44);
    expect(style.borderWidth).toBeUndefined();
    expect(style.backgroundColor).toBeUndefined();
  });

  it('uses a labeled, visually quiet entry point for reordering Today\'s Focus', () => {
    storeState.tasks = [
      makeTask('focus-a', { title: 'A', isFocusedToday: true, focusOrder: 0 }),
      makeTask('focus-b', { title: 'B', isFocusedToday: true, focusOrder: 1 }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    const reorderButton = tree.root.findByProps({ testID: 'focus-reorder-toggle' });
    const style = flattenStyle(reorderButton.props.style);

    expect(textContent(reorderButton)).toContain('Reorder');
    expect(style.minHeight).toBe(36);
    expect(style.borderWidth).toBeUndefined();
    expect(style.backgroundColor).toBeUndefined();
    expect(reorderButton.props.accessibilityHint).toBeTruthy();
  });

  it('keeps Today\'s Focus visible when collapsing Next Actions', () => {
    storeState.tasks = [
      makeTask('focused-next', { title: 'Focused next', isFocusedToday: true }),
      makeTask('plain-next', { title: 'Plain next' }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    const nextSectionButton = tree.root.find((node) =>
      node.props.accessibilityLabel === 'Next Actions' && typeof node.props.onPress === 'function'
    );

    act(() => {
      nextSectionButton.props.onPress();
    });

    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id),
    ).toEqual(['focused-next']);
  });

  it('does not render a Today\'s Focus section when no task is starred', () => {
    storeState.tasks = [
      makeTask('plain-next', { title: 'Plain next' }),
      makeTask('another-next', { title: 'Another next' }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    expect(() =>
      tree.root.find((node) =>
        node.props.accessibilityLabel === "Today's Focus" && typeof node.props.onPress === 'function'
      )
    ).toThrow();
  });

  it('renders the empty state when every Focus section is empty', () => {
    storeState.tasks = [];
    storeState.projects = [];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    expect(tree.root.findByType(SectionList).props.sections).toEqual([]);
    expect(tree.root.findByProps({ children: 'All clear' })).toBeTruthy();
  });

  it('renders the Upcoming section instead of the empty state when it is the only Focus content', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 1, 12, 0, 0, 0));
    storeState.tasks = [
      makeTask('starts-tomorrow', { title: 'Starts tomorrow', startTime: '2026-04-02' }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    findButtonByLabel(tree, 'Upcoming');
    expect(tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id))
      .toEqual(['starts-tomorrow']);
    expect(() => tree.root.findByProps({ children: 'All clear' })).toThrow();
    vi.useRealTimers();
  });

  it('collapses the Next Actions section without showing the empty state', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    expect(tree.root.findAllByType(SwipeableTaskItem)).toHaveLength(2);

    const nextSectionButton = tree.root.find((node) =>
      node.props.accessibilityLabel === 'Next Actions' && typeof node.props.onPress === 'function'
    );

    expect(nextSectionButton.props.accessibilityState).toEqual({ expanded: true });

    act(() => {
      nextSectionButton.props.onPress();
    });

    expect(nextSectionButton.props.accessibilityState).toEqual({ expanded: false });
    expect(tree.root.findAllByType(SwipeableTaskItem)).toHaveLength(1);
    expect(() => tree.root.findByProps({ children: 'All clear' })).toThrow();
  });

  it('restores the persisted Next Actions collapsed state', async () => {
    const deferred = createDeferred<string | null>();
    asyncStorageMock.getItem.mockReturnValue(deferred.promise);
    storeState.tasks = [
      makeTask('focused-next', { title: 'Focused next', isFocusedToday: true }),
      makeTask('plain-next', { title: 'Plain next' }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    expect(tree.root.findAllByType(SwipeableTaskItem)).toHaveLength(0);

    await act(async () => {
      deferred.resolve(JSON.stringify({
        expandedSections: { nextActions: false },
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const nextSectionButton = tree.root.find((node) =>
      node.props.accessibilityLabel === 'Next Actions' && typeof node.props.onPress === 'function'
    );

    expect(asyncStorageMock.getItem).toHaveBeenCalledWith('mindwtr:view:focus:v1');
    expect(nextSectionButton.props.accessibilityState).toEqual({ expanded: false });
    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id),
    ).toEqual(['focused-next']);
  });

  it('persists the Next Actions expanded state when toggled', () => {
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    const nextSectionButton = tree.root.find((node) =>
      node.props.accessibilityLabel === 'Next Actions' && typeof node.props.onPress === 'function'
    );

    act(() => {
      nextSectionButton.props.onPress();
    });

    expect(asyncStorageMock.setItem).toHaveBeenCalledWith(
      'mindwtr:view:focus:v1',
      JSON.stringify({
        showDetails: false,
        expandedSections: {
          focus: true,
          schedule: true,
          next: false,
          nextActions: false,
          upcoming: true,
          reviewDue: true,
          reviewProjects: true,
        },
      })
    );
  });

  it('hydrates showDetails to hidden when the persisted blob lacks the field', async () => {
    const deferred = createDeferred<string | null>();
    asyncStorageMock.getItem.mockReturnValue(deferred.promise);

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<FocusScreen />);
    });

    await act(async () => {
      deferred.resolve(JSON.stringify({
        expandedSections: { nextActions: false },
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const detailsButton = tree.root.find((node) =>
      node.props.accessibilityLabel === 'Show details' && typeof node.props.onPress === 'function'
    );
    expect(detailsButton).toBeTruthy();
  });

  it('flips showDetails from the header toggle and persists it in the view-state blob', () => {
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<FocusScreen />);
    });

    const detailsButton = tree.root.find((node) =>
      node.props.accessibilityLabel === 'Show details' && typeof node.props.onPress === 'function'
    );

    act(() => {
      detailsButton.props.onPress();
    });

    expect(asyncStorageMock.setItem).toHaveBeenCalledWith(
      'mindwtr:view:focus:v1',
      JSON.stringify({
        showDetails: true,
        expandedSections: {
          focus: true,
          schedule: true,
          next: true,
          nextActions: true,
          upcoming: true,
          reviewDue: true,
          reviewProjects: true,
        },
      })
    );

    const flippedButton = tree.root.find((node) =>
      node.props.accessibilityLabel === 'Hide details' && typeof node.props.onPress === 'function'
    );
    expect(flippedButton).toBeTruthy();
  });

  it('previews deferred and recurring tasks surfacing within a week under Upcoming (#1061)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 5, 12, 0, 0, 0));
    storeState.tasks = [
      makeTask('deferred-soon', { title: 'Deferred soon', startTime: '2026-04-08' }),
      makeTask('recurring-soon', { title: 'Recurring soon', dueDate: '2026-04-10', recurrence: { rule: 'weekly' } }),
      makeTask('deferred-far', { title: 'Deferred far', startTime: '2026-04-20' }),
      makeTask('plain-next', { title: 'Plain next' }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    findButtonByLabel(tree, 'Upcoming');
    const shownIds = tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id);
    expect(shownIds).toContain('deferred-soon');
    expect(shownIds).toContain('recurring-soon');
    expect(shownIds).not.toContain('deferred-far');
    // Reveal-date order inside the section: start Apr 8 before due Apr 10.
    expect(shownIds.indexOf('deferred-soon')).toBeLessThan(shownIds.indexOf('recurring-soon'));
    vi.useRealTimers();
  });

  it('disables the Upcoming star and gives each row its reveal date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 5, 12, 0, 0, 0));
    storeState.tasks = [
      makeTask('deferred-soon', { title: 'Deferred soon', startTime: '2026-04-08' }),
      makeTask('plain-next', { title: 'Plain next' }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    const rows = tree.root.findAllByType(SwipeableTaskItem);
    const upcomingRow = rows.find((node) => node.props.task.id === 'deferred-soon');
    const nextRow = rows.find((node) => node.props.task.id === 'plain-next');
    // Deferred by construction: the star can only refuse, so it announces why
    // rather than offering a tap that ends in a toast.
    expect(upcomingRow?.props.focusToggleDisabledLabel)
      .toBe('This task is deferred; change its start date before focusing it.');
    expect(nextRow?.props.focusToggleDisabledLabel).toBeUndefined();
    // The reveal date is the section's purpose, so it rides the row.
    expect(upcomingRow?.props.footerContent).toBeTruthy();
    expect(nextRow?.props.footerContent).toBeUndefined();
    vi.useRealTimers();
  });

  it('classifies bare due dates against the local end of day, not UTC midnight', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 10, 12, 0, 0, 0));
    storeState.tasks = [
      makeTask('due-today', { title: 'Due today', dueDate: '2026-04-10' }),
      makeTask('due-tomorrow', { title: 'Due tomorrow', dueDate: '2026-04-11' }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    const sections = tree.root.findByType(SectionList).props.sections as {
      title: string;
      data: { type: string; task?: Task }[];
    }[];
    const idsIn = (title: string) => sections
      .find((section) => section.title === title)?.data
      .map((item) => item.task?.id) ?? [];

    expect(idsIn('Today')).toEqual(['due-today']);
    expect(idsIn('Next Actions')).toEqual(['due-tomorrow']);
    vi.useRealTimers();
  });

  it('renders mobile Next Actions flat by default', () => {
    storeState.tasks = [
      makeTask('work-next', { title: 'Work next', contexts: ['@work'] }),
      makeTask('no-context-next', { title: 'No context next' }),
      makeTask('home-next', { title: 'Home next', contexts: ['@home'] }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    expect(
      tree.root.findAllByType(View)
        .filter((node) => node.props.accessibilityRole === 'header')
        .map((node) => node.props.accessibilityLabel),
    ).toEqual([]);
    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id),
    ).toEqual(['home-next', 'no-context-next', 'work-next']);
  });

  it('surfaces one next action from a project due today before unrelated undated tasks', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-10T12:00:00.000Z'));
    storeState.projects = [
      makeProject('due-project', {
        title: 'Due project',
        // Same instant as the fake clock, so "due today" holds in every timezone.
        dueDate: '2026-04-10T12:00:00.000Z',
      }),
    ];
    storeState.tasks = [
      makeTask('unrelated-next', {
        title: 'Unrelated next',
        createdAt: '2026-04-01T00:00:00.000Z',
      }),
      makeTask('project-second', {
        title: 'Project second',
        projectId: 'due-project',
        order: 1,
        orderNum: 1,
        createdAt: '2026-04-02T00:00:00.000Z',
      }),
      makeTask('project-first', {
        title: 'Project first',
        projectId: 'due-project',
        order: 0,
        orderNum: 0,
        createdAt: '2026-04-03T00:00:00.000Z',
      }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    const rows = tree.root.findAllByType(SwipeableTaskItem);
    expect(rows.map((node) => node.props.task.id)).toEqual([
      'project-first',
      'unrelated-next',
      'project-second',
    ]);
    expect(rows[0]?.props.projectDeadlineLabel).toBe('Project due today');
    expect(rows[1]?.props.projectDeadlineLabel).toBeUndefined();
    expect(rows[2]?.props.projectDeadlineLabel).toBeUndefined();
    expect(rows[0]?.props.task.dueDate).toBeUndefined();
  });

  it('groups mobile Next Actions under context headers when selected', () => {
    storeState.settings = {
      appearance: {},
      features: {},
      gtd: { focusGroupBy: 'context' },
    } as any;
    storeState.tasks = [
      makeTask('work-next', { title: 'Work next', contexts: ['@work'] }),
      makeTask('no-context-next', { title: 'No context next' }),
      makeTask('home-next', { title: 'Home next', contexts: ['@home'] }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    expect(
      tree.root.findAllByType(View)
        .filter((node) => node.props.accessibilityRole === 'header')
        .map((node) => node.props.accessibilityLabel),
    ).toEqual(['No context 1', '@home 1', '@work 1']);
    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id),
    ).toEqual(['no-context-next', 'home-next', 'work-next']);
  });

  it('updates the mobile Focus list identity when grouping changes to a single context group', () => {
    storeState.tasks = [
      makeTask('work-first', { title: 'Work first', contexts: ['@work'] }),
      makeTask('work-second', { title: 'Work second', contexts: ['@work'] }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    const initialListVersion = tree.root.findByType(SectionList).props.extraData;

    act(() => {
      storeState.settings = {
        appearance: {},
        features: {},
        gtd: { focusGroupBy: 'context' },
      } as any;
      tree.update(<FocusScreen />);
    });

    expect(tree.root.findByType(SectionList).props.extraData).not.toEqual(initialListVersion);
    expect(
      tree.root.findAllByType(View)
        .filter((node) => node.props.accessibilityRole === 'header')
        .map((node) => node.props.accessibilityLabel),
    ).toEqual(['@work 2']);
    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id),
    ).toEqual(['work-first', 'work-second']);
  });

  it('saves the Focus group-by preference from the filter sheet', async () => {
    storeState.updateSettings.mockResolvedValue(undefined);

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    act(() => {
      findButtonByLabel(tree, 'Filters').props.onPress();
    });
    await act(async () => {
      findButtonByText(tree, 'Project').props.onPress();
    });

    expect(storeState.updateSettings).toHaveBeenCalledWith({
      gtd: { focusGroupBy: 'project' },
    });
  });

  it('persists clearing the Focus group-by preference from the filter sheet', async () => {
    storeState.settings = {
      appearance: {},
      features: {},
      gtd: { focusGroupBy: 'priority' as any },
    };
    storeState.updateSettings.mockResolvedValue(undefined);

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    act(() => {
      findButtonByLabel(tree, 'Filters').props.onPress();
    });

    await act(async () => {
      findButtonByText(tree, 'None').props.onPress();
    });

    expect(storeState.updateSettings).toHaveBeenCalledWith({
      gtd: { focusGroupBy: 'none' },
    });
  });

  it('renders review-due tasks in a dedicated Review Due section and allows collapsing it', () => {
    storeState.tasks = [
      makeTask('waiting-review', {
        status: 'waiting',
        title: 'Waiting review',
        reviewAt: '2000-01-01T00:00:00.000Z',
      }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id),
    ).toEqual(['waiting-review']);

    const reviewDueButton = tree.root.find((node) =>
      node.props.accessibilityLabel === 'Review Due' && typeof node.props.onPress === 'function'
    );

    expect(reviewDueButton.props.accessibilityState).toEqual({ expanded: true });

    act(() => {
      reviewDueButton.props.onPress();
    });

    expect(reviewDueButton.props.accessibilityState).toEqual({ expanded: false });
    expect(tree.root.findAllByType(SwipeableTaskItem)).toHaveLength(0);
    expect(() => tree.root.findByProps({ children: 'All clear' })).toThrow();
  });

  it('orders mobile Focus sections as Schedule, Review Due, Next Actions, Upcoming, then Projects to review', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-05T12:00:00.000Z'));
    storeState.tasks = [
      makeTask('schedule-task', { dueDate: '2026-04-05' }),
      makeTask('review-task', {
        status: 'waiting',
        reviewAt: '2026-04-04T12:00:00.000Z',
      }),
      makeTask('next-task'),
      makeTask('upcoming-task', { startTime: '2026-04-08T09:00:00.000Z' }),
    ];

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<FocusScreen />);
    });

    const sections = tree.root.findByType(SectionList).props.sections as { title: string }[];
    expect(sections.map((section) => section.title)).toEqual([
      'Today',
      'Review Due',
      'Next Actions',
      'Upcoming',
      'Projects to review',
    ]);
  });

  it('keeps mobile Focus tasks exclusive with Schedule ahead of Review Due ahead of Next Actions', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-05T12:00:00.000Z'));
    storeState.tasks = [
      makeTask('scheduled-review-next', {
        dueDate: '2026-04-05',
        reviewAt: '2026-04-04T12:00:00.000Z',
      }),
      makeTask('review-next', { reviewAt: '2026-04-04T12:00:00.000Z' }),
      makeTask('plain-next'),
    ];

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<FocusScreen />);
    });

    const sections = tree.root.findByType(SectionList).props.sections as {
      title: string;
      data: { type: string; task?: Task }[];
    }[];
    const idsIn = (title: string) => sections
      .find((section) => section.title === title)?.data
      .map((item) => item.task?.id)
      .filter(Boolean) ?? [];
    const allTaskIds = sections.flatMap((section) => section.data)
      .flatMap((item) => item.task ? [item.task.id] : []);

    expect(idsIn('Today')).toEqual(['scheduled-review-next']);
    expect(idsIn('Review Due')).toEqual(['review-next']);
    expect(idsIn('Next Actions')).toEqual(['plain-next']);
    expect(allTaskIds).toEqual(['scheduled-review-next', 'review-next', 'plain-next']);
  });

  it('shows a next task with a timed start later today in Today, not Next Actions or Upcoming', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 5, 12, 0, 0, 0));
    storeState.tasks = [
      makeTask('later-today-next', {
        title: 'Later today next task',
        startTime: new Date(2026, 3, 5, 17, 0, 0, 0).toISOString(),
      }),
    ];

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<FocusScreen />);
    });

    const sections = tree.root.findByType(SectionList).props.sections as {
      title: string;
      data: { type: string; task?: Task }[];
    }[];
    const idsIn = (title: string) => sections
      .find((section) => section.title === title)?.data
      .map((item) => item.task?.id)
      .filter(Boolean) ?? [];

    expect(idsIn('Today')).toEqual(['later-today-next']);
    expect(idsIn('Next Actions')).toEqual([]);
    expect(idsIn('Upcoming')).toEqual([]);
    vi.useRealTimers();
  });

  it('shows the pending footer on a Today row until its start time arrives, star enabled', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 5, 12, 0, 0, 0));
    storeState.tasks = [
      makeTask('later-today-next', {
        title: 'Later today next task',
        startTime: new Date(2026, 3, 5, 17, 0, 0, 0).toISOString(),
      }),
    ];

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<FocusScreen />);
    });

    const findRow = () => tree.root.findAllByType(SwipeableTaskItem)
      .find((node) => node.props.task.id === 'later-today-next');
    // Planning the 17:00 task for today is legitimate, so the star must not
    // pick up Upcoming's disabled-for-deferred gating.
    expect(findRow()?.props.focusToggleDisabledLabel).toBeUndefined();
    expect(findRow()?.props.footerContent).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(5 * 60 * 60 * 1000 + 1000); // past 17:00
    });

    expect(findRow()?.props.footerContent).toBeUndefined();
    vi.useRealTimers();
  });

  it('keeps a task due today with a start on another day in Upcoming only, not Today', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 5, 12, 0, 0, 0));
    storeState.tasks = [
      makeTask('due-today-start-tomorrow', {
        title: 'Due today but starts tomorrow',
        dueDate: '2026-04-05',
        startTime: '2026-04-06',
      }),
      // Without a second task landing in another section, hasTasks (based on
      // schedule/nextActions/reviewDue only, not upcoming) hides the whole
      // list — a pre-existing gap out of this fix's scope. Keep this row so
      // the assertion below tests the schedule-pool fix, not that gap.
      makeTask('plain-next', { title: 'Plain next' }),
    ];

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<FocusScreen />);
    });

    const sections = tree.root.findByType(SectionList).props.sections as {
      title: string;
      data: { type: string; task?: Task }[];
    }[];
    const idsIn = (title: string) => sections
      .find((section) => section.title === title)?.data
      .map((item) => item.task?.id)
      .filter(Boolean) ?? [];

    expect(idsIn('Today')).toEqual([]);
    expect(idsIn('Next Actions')).toEqual(['plain-next']);
    expect(idsIn('Upcoming')).toEqual(['due-today-start-tomorrow']);
    vi.useRealTimers();
  });

  it('sorts Today rows by the earliest due/start time under the default Focus sort', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 5, 6, 0, 0, 0));
    storeState.tasks = [
      makeTask('ten-oclock', {
        title: 'Ten oclock start',
        startTime: new Date(2026, 3, 5, 10, 0, 0, 0).toISOString(),
      }),
      makeTask('nine-oclock', {
        title: 'Nine oclock start',
        startTime: new Date(2026, 3, 5, 9, 0, 0, 0).toISOString(),
      }),
    ];

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<FocusScreen />);
    });

    const sections = tree.root.findByType(SectionList).props.sections as {
      title: string;
      data: { type: string; task?: Task }[];
    }[];
    const idsIn = (title: string) => sections
      .find((section) => section.title === title)?.data
      .map((item) => item.task?.id)
      .filter(Boolean) ?? [];

    expect(idsIn('Today')).toEqual(['nine-oclock', 'ten-oclock']);
    vi.useRealTimers();
  });

  it('shows the status badge on review-due rows but keeps it hidden on next actions', () => {
    storeState.tasks = [
      makeTask('plain-next', { title: 'Plain next' }),
      makeTask('waiting-review', {
        status: 'waiting',
        title: 'Waiting review',
        reviewAt: '2000-01-01T00:00:00.000Z',
      }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    const rows = tree.root.findAllByType(SwipeableTaskItem);
    const reviewRow = rows.find((node) => node.props.task.id === 'waiting-review');
    const nextRow = rows.find((node) => node.props.task.id === 'plain-next');

    expect(reviewRow?.props.hideStatusBadge).toBe(false);
    expect(nextRow?.props.hideStatusBadge).toBe(true);
  });

  it('marks a review-due Focus task reviewed from the row action and offers undo', async () => {
    const alertSpy = vi.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.text === 'Mark reviewed')?.onPress?.();
    });
    const reviewAt = '2000-01-01T00:00:00.000Z';
    storeState.tasks = [
      makeTask('waiting-review', {
        status: 'waiting',
        title: 'Waiting review',
        reviewAt,
      }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    const row = tree.root.findAllByType(SwipeableTaskItem).find((node) => node.props.task.id === 'waiting-review');
    expect(row?.props.onLongPressAction).toBeTypeOf('function');
    expect(row?.props.onLongPressActionLabel).toBe('Mark reviewed');

    await act(async () => {
      row?.props.onLongPressAction(row.props.task);
      await Promise.resolve();
    });

    expect(alertSpy).toHaveBeenCalled();
    expect(storeState.updateTask).toHaveBeenCalledWith('waiting-review', { reviewAt: undefined });
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Waiting review',
      message: 'Marked reviewed',
      actionLabel: 'Undo',
      onAction: expect.any(Function),
    }));

    const toast = showToastMock.mock.calls[0]?.[0] as { onAction?: () => Promise<void> | void };
    await act(async () => {
      await toast.onAction?.();
    });

    expect(storeState.updateTask).toHaveBeenLastCalledWith('waiting-review', { reviewAt });
    alertSpy.mockRestore();
  });

  it('advances a review-due Focus task by one week from the row action', async () => {
    const alertSpy = vi.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.text === 'Review in 1 week')?.onPress?.();
    });
    const reviewAt = '2000-01-01T00:00:00.000Z';
    storeState.tasks = [
      makeTask('waiting-review', {
        status: 'waiting',
        title: 'Waiting review',
        reviewAt,
      }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    const row = tree.root.findAllByType(SwipeableTaskItem).find((node) => node.props.task.id === 'waiting-review');

    await act(async () => {
      row?.props.onLongPressAction(row.props.task);
      await Promise.resolve();
    });

    expect(storeState.updateTask).toHaveBeenCalledWith(
      'waiting-review',
      { reviewAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/) },
    );
    const nextReviewAt = (storeState.updateTask.mock.calls[0]?.[1] as { reviewAt?: string }).reviewAt;
    const expected = new Date();
    expected.setDate(expected.getDate() + 7);
    expect(nextReviewAt?.slice(0, 10)).toBe(
      `${expected.getFullYear()}-${String(expected.getMonth() + 1).padStart(2, '0')}-${String(expected.getDate()).padStart(2, '0')}`,
    );
    alertSpy.mockRestore();
  });

  it('does not duplicate review-due next actions in earlier Focus sections', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-02T12:00:00.000Z'));
    storeState.tasks = [
      makeTask('plain-next', { title: 'Plain next' }),
      makeTask('review-due-next', {
        title: 'Review due next',
        reviewAt: '2026-04-02T09:00:00.000Z',
      }),
      makeTask('review-due-scheduled', {
        title: 'Review due scheduled',
        dueDate: '2026-04-02',
        reviewAt: '2026-04-02T09:30:00.000Z',
      }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    const rowIds = tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id);
    expect(rowIds).toHaveLength(3);
    expect(rowIds.filter((id) => id === 'review-due-next')).toHaveLength(1);
    expect(rowIds.filter((id) => id === 'review-due-scheduled')).toHaveLength(1);
    expect(textContent(tree.root)).toContain('Review Due');
  });

  it('does not let earlier non-Focus tasks hide the next task in a sequential project', () => {
    storeState.projects = [makeProject('project-1', { isSequential: true })];
    storeState.tasks = [
      makeTask('inbox-before', {
        status: 'inbox',
        projectId: 'project-1',
        order: 0,
        orderNum: 0,
      }),
      makeTask('available-next', {
        status: 'next',
        projectId: 'project-1',
        order: 1,
        orderNum: 1,
      }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id),
    ).toEqual(['available-next']);
  });

  it('shows the first next action from each section for section-scoped sequential projects', () => {
    storeState.projects = [makeProject('project-1', { isSequential: true, sequentialScope: 'section' })];
    storeState.tasks = [
      makeTask('section-a-first', {
        status: 'next',
        projectId: 'project-1',
        sectionId: 'section-a',
        order: 0,
        orderNum: 0,
      }),
      makeTask('section-a-second', {
        status: 'next',
        projectId: 'project-1',
        sectionId: 'section-a',
        order: 1,
        orderNum: 1,
      }),
      makeTask('section-b-first', {
        status: 'next',
        projectId: 'project-1',
        sectionId: 'section-b',
        order: 2,
        orderNum: 2,
      }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id),
    ).toEqual(['section-a-first', 'section-b-first']);
  });

  it('hides tasks that belong to deferred projects', () => {
    storeState.projects = [
      makeProject('active-project'),
      makeProject('someday-project', { status: 'someday' }),
    ];
    storeState.tasks = [
      makeTask('active-next', {
        title: 'Active next',
        projectId: 'active-project',
      }),
      makeTask('someday-next', {
        title: 'Someday next',
        projectId: 'someday-project',
      }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id),
    ).toEqual(['active-next']);
  });

  it('does not show later sequential actions when the first action has a hidden future start', () => {
    storeState.projects = [makeProject('project-1', { isSequential: true })];
    storeState.settings = {
      appearance: { showFutureStarts: true },
      features: {},
    };
    storeState.tasks = [
      makeTask('future-first', {
        status: 'next',
        projectId: 'project-1',
        order: 0,
        orderNum: 0,
        startTime: '2099-05-03T09:00:00.000Z',
      }),
      makeTask('following-next', {
        status: 'next',
        projectId: 'project-1',
        order: 1,
        orderNum: 1,
      }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id),
    ).toEqual([]);
  });

  it('always hides future-start tasks without a helper notice', () => {
    storeState.settings = {
      appearance: { showFutureStarts: true },
      features: {},
    };
    storeState.tasks = [
      makeTask('future-first', {
        title: 'Wait for vendor',
        startTime: '2099-05-03T09:00:00.000Z',
      }),
      makeTask('next-now', {
        title: 'Current next',
      }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id),
    ).toEqual(['next-now']);
    expect(textContent(tree.root)).not.toContain('future-start task');
    expect(textContent(tree.root)).not.toContain('Wait for vendor');
  });

  it('refreshes date-sensitive sections at local midnight', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 2, 23, 59, 59, 900));
    storeState.tasks = [
      makeTask('starts-tomorrow', {
        title: 'Starts tomorrow',
        startTime: '2026-05-03',
      }),
    ];

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<FocusScreen />);
    });
    expect(textContent(tree.root)).not.toContain('Starts tomorrow');

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id))
      .toContain('starts-tomorrow');
  });

  it('refreshes date-sensitive sections when the app resumes on a new day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 2, 10, 0, 0));
    let onAppStateChange: ((state: string) => void) | undefined;
    const appStateSpy = vi.spyOn(AppState, 'addEventListener').mockImplementation(((_event: string, listener: (state: string) => void) => {
      onAppStateChange = listener;
      return { remove: vi.fn() };
    }) as typeof AppState.addEventListener);
    storeState.tasks = [
      makeTask('starts-tomorrow', {
        title: 'Starts tomorrow',
        startTime: '2026-05-03',
      }),
    ];

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<FocusScreen />);
    });
    expect(textContent(tree.root)).not.toContain('Starts tomorrow');

    vi.setSystemTime(new Date(2026, 4, 3, 10, 0, 0));
    act(() => {
      onAppStateChange?.('active');
    });

    expect(tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id))
      .toContain('starts-tomorrow');
    appStateSpy.mockRestore();
  });

  it('applies and clears saved Focus filters from the chip row', () => {
    storeState.settings = {
      appearance: {},
      features: {},
      savedFilters: [{
        id: 'filter-desk',
        name: 'Desk',
        view: 'focus',
        criteria: { contexts: ['@desk'] },
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      }],
    } as any;
    storeState.tasks = [
      makeTask('desk-task', { title: 'Desk task', contexts: ['@desk'] }),
      makeTask('phone-task', { title: 'Phone task', contexts: ['@phone'] }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    act(() => {
      findButtonByText(tree, 'Desk').props.onPress();
    });

    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id),
    ).toEqual(['desk-task']);

    act(() => {
      findButtonByText(tree, 'All').props.onPress();
    });

    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id),
    ).toEqual(['desk-task', 'phone-task']);
  });

  it('can switch multiple context filters from all to any matching', () => {
    storeState.tasks = [
      makeTask('desk-task', { title: 'Desk task', contexts: ['@desk'] }),
      makeTask('phone-task', { title: 'Phone task', contexts: ['@phone'] }),
      makeTask('desk-phone-task', { title: 'Desk and phone task', contexts: ['@desk', '@phone'] }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    act(() => {
      findButtonByLabel(tree, 'Filters').props.onPress();
    });
    act(() => {
      findButtonByText(tree, '@desk').props.onPress();
    });
    act(() => {
      findButtonByText(tree, '@phone').props.onPress();
    });

    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id),
    ).toEqual(['desk-phone-task']);

    act(() => {
      findButtonByText(tree, 'Any').props.onPress();
    });

    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id).sort(),
    ).toEqual(['desk-phone-task', 'desk-task', 'phone-task']);
  });

  it('deletes the active saved Focus filter from the chip row', async () => {
    const alertSpy = vi.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.style === 'destructive')?.onPress?.();
    });
    storeState.updateSettings.mockResolvedValue(undefined);
    storeState.settings = {
      appearance: {},
      features: {},
      savedFilters: [{
        id: 'filter-desk',
        name: 'Desk',
        view: 'focus',
        criteria: { contexts: ['@desk'] },
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      }],
    } as any;
    storeState.tasks = [
      makeTask('desk-task', { title: 'Desk task', contexts: ['@desk'] }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    act(() => {
      findButtonByText(tree, 'Desk').props.onPress();
    });
    await act(async () => {
      findButtonByLabel(tree, 'Delete saved filter Desk').props.onPress();
    });

    expect(alertSpy).toHaveBeenCalled();
    expect(storeState.updateSettings).toHaveBeenCalledWith({
      savedFilters: [
        expect.objectContaining({
          id: 'filter-desk',
          deletedAt: expect.any(String),
        }),
      ],
    });

    alertSpy.mockRestore();
  });

  it('removes advanced synced criteria from the active saved Focus filter', async () => {
    const alertSpy = vi.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find((button) => button.style === 'destructive')?.onPress?.();
    });
    storeState.updateSettings.mockResolvedValue(undefined);
    storeState.settings = {
      appearance: {},
      features: {},
      savedFilters: [{
        id: 'filter-desk',
        name: 'Desk',
        view: 'focus',
        criteria: {
          contexts: ['@desk'],
          dueDateRange: { preset: 'this_week' },
          hasDescription: true,
        },
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
      }],
    } as any;
    storeState.tasks = [
      makeTask('desk-task', { title: 'Desk task', contexts: ['@desk'] }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    act(() => {
      findButtonByText(tree, 'Desk').props.onPress();
    });
    await act(async () => {
      findButtonByLabel(tree, 'Delete Due Date: This week').props.onPress();
    });

    expect(alertSpy).toHaveBeenCalled();
    expect(storeState.updateSettings).toHaveBeenCalledWith({
      savedFilters: [expect.objectContaining({
        id: 'filter-desk',
        criteria: {
          contexts: ['@desk'],
          hasDescription: true,
        },
        updatedAt: expect.any(String),
      })],
    });

    alertSpy.mockRestore();
  });

  it('saves the current Focus filter from the existing filter sheet', async () => {
    storeState.updateSettings.mockResolvedValue(undefined);
    storeState.tasks = [
      makeTask('low-energy-task', { energyLevel: 'low' }),
      makeTask('high-energy-task', { energyLevel: 'high' }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    const filterButton = tree.root.find((node) =>
      node.props.accessibilityLabel === 'Filters' && typeof node.props.onPress === 'function'
    );

    act(() => {
      filterButton.props.onPress();
    });
    act(() => {
      findButtonByText(tree, 'High energy').props.onPress();
    });
    act(() => {
      findButtonByText(tree, 'Save', { last: true }).props.onPress();
    });

    const inputs = tree.root.findAllByType(TextInput);
    const input = inputs[inputs.length - 1];
    await act(async () => {
      input.props.onChangeText('High energy preset');
    });
    await act(async () => {
      findButtonByText(tree, 'Save', { last: true }).props.onPress();
    });

    expect(storeState.updateSettings).toHaveBeenCalledWith({
      savedFilters: [expect.objectContaining({
        name: 'High energy preset',
        view: 'focus',
        criteria: { energy: ['high'] },
      })],
    });
  });

  it('saves context any matching in Focus filters', async () => {
    storeState.updateSettings.mockResolvedValue(undefined);
    storeState.tasks = [
      makeTask('desk-task', { contexts: ['@desk'] }),
      makeTask('phone-task', { contexts: ['@phone'] }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    act(() => {
      findButtonByLabel(tree, 'Filters').props.onPress();
    });
    act(() => {
      findButtonByText(tree, '@desk').props.onPress();
    });
    act(() => {
      findButtonByText(tree, '@phone').props.onPress();
    });
    act(() => {
      findButtonByText(tree, 'Any').props.onPress();
    });
    act(() => {
      findButtonByText(tree, 'Save', { last: true }).props.onPress();
    });

    const inputs = tree.root.findAllByType(TextInput);
    const input = inputs[inputs.length - 1];
    await act(async () => {
      input.props.onChangeText('Desk or phone');
    });
    await act(async () => {
      findButtonByText(tree, 'Save', { last: true }).props.onPress();
    });

    expect(storeState.updateSettings).toHaveBeenCalledWith({
      savedFilters: [expect.objectContaining({
        name: 'Desk or phone',
        view: 'focus',
        criteria: {
          contexts: ['@desk', '@phone'],
          contextMatchMode: 'any',
        },
      })],
    });
  });

  it('saves tag any matching in Focus filters', async () => {
    storeState.updateSettings.mockResolvedValue(undefined);
    storeState.tasks = [
      makeTask('quick-task', { tags: ['#quick'] }),
      makeTask('calls-task', { tags: ['#calls'] }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    act(() => {
      findButtonByLabel(tree, 'Filters').props.onPress();
    });
    act(() => {
      findButtonByText(tree, '#quick').props.onPress();
    });
    act(() => {
      findButtonByText(tree, '#calls').props.onPress();
    });
    act(() => {
      findButtonByText(tree, 'Any').props.onPress();
    });
    act(() => {
      findButtonByText(tree, 'Save', { last: true }).props.onPress();
    });

    const inputs = tree.root.findAllByType(TextInput);
    const input = inputs[inputs.length - 1];
    await act(async () => {
      input.props.onChangeText('Quick or calls');
    });
    await act(async () => {
      findButtonByText(tree, 'Save', { last: true }).props.onPress();
    });

    expect(storeState.updateSettings).toHaveBeenCalledWith({
      savedFilters: [expect.objectContaining({
        name: 'Quick or calls',
        view: 'focus',
        criteria: {
          tags: ['#quick', '#calls'],
          tagMatchMode: 'any',
        },
      })],
    });
  });

  it('saves multiple contexts and a tag through one native modal and restores them after relaunch', async () => {
    storeState.tasks = [
      makeTask('matching-task', {
        title: 'Matching task',
        contexts: ['@desk', '@phone'],
        tags: ['#urgent'],
      }),
      makeTask('missing-context', {
        title: 'Missing context',
        contexts: ['@desk'],
        tags: ['#urgent'],
      }),
      makeTask('missing-tag', {
        title: 'Missing tag',
        contexts: ['@desk', '@phone'],
      }),
    ];
    const actualCore = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
    const cloneDocument = (data: AppData): AppData => JSON.parse(JSON.stringify(data)) as AppData;
    let persistedDocument: AppData = {
      tasks: storeState.tasks,
      projects: [],
      sections: [],
      areas: [],
      people: [],
      settings: { appearance: {}, features: {}, deviceId: 'focus-filter-test-device' },
    };
    const storage: StorageAdapter = {
      getData: vi.fn(async () => cloneDocument(persistedDocument)),
      saveData: vi.fn(async (data) => {
        persistedDocument = cloneDocument(data);
      }),
    };
    actualCore.resetForTests();
    actualCore.setStorageAdapter(storage);
    actualCore.useTaskStore.setState({ lastDataChangeAt: 0 });
    await actualCore.useTaskStore.getState().fetchData({ silent: true });
    storeState.settings = actualCore.useTaskStore.getState().settings;
    storeState.updateSettings.mockImplementationOnce(async (updates: Partial<AppSettings>) => {
      await actualCore.useTaskStore.getState().updateSettings(updates);
      storeState.settings = actualCore.useTaskStore.getState().settings;
    });

    let tree!: ReturnType<typeof create>;
    const visibleModals = () => tree.root.findAllByType(Modal).filter((modal) => modal.props.visible);
    const visibleModal = () => {
      const modals = visibleModals();
      expect(modals).toHaveLength(1);
      return modals[0];
    };
    const buttonInVisibleModal = (text: string) => (
      findButtonByText(tree, text, { root: visibleModal() })
    );

    act(() => {
      tree = create(<FocusScreen />);
    });
    act(() => {
      findButtonByLabel(tree, 'Filters').props.onPress();
    });
    act(() => {
      buttonInVisibleModal('@desk').props.onPress();
    });
    act(() => {
      buttonInVisibleModal('@phone').props.onPress();
    });
    act(() => {
      buttonInVisibleModal('#urgent').props.onPress();
    });
    act(() => {
      buttonInVisibleModal('Save').props.onPress();
    });

    // iOS can only present one native Modal at a time. The save-name prompt
    // must replace the filter sheet instead of being presented on top of it.
    const nameDialog = visibleModal();
    const nameInput = nameDialog.findByType(TextInput);
    act(() => {
      nameInput.props.onChangeText('Desk phone urgent');
    });
    await act(async () => {
      buttonInVisibleModal('Save').props.onPress();
      await Promise.resolve();
    });

    expect(visibleModals()).toHaveLength(0);
    expect(storeState.updateSettings).toHaveBeenCalledWith({
      savedFilters: [expect.objectContaining({
        name: 'Desk phone urgent',
        view: 'focus',
        criteria: {
          contexts: ['@desk', '@phone'],
          tags: ['#urgent'],
          contextMatchMode: 'all',
        },
      })],
    });
    await actualCore.flushPendingSave();
    expect(storage.saveData).toHaveBeenCalled();

    act(() => {
      tree.unmount();
    });
    actualCore.useTaskStore.setState({
      tasks: [],
      projects: [],
      sections: [],
      areas: [],
      people: [],
      settings: {},
      _allTasks: [],
      _allProjects: [],
      _allSections: [],
      _allAreas: [],
      _allPeople: [],
      lastDataChangeAt: 0,
    });
    await actualCore.useTaskStore.getState().fetchData({ silent: true });
    storeState.settings = JSON.parse(
      JSON.stringify(actualCore.useTaskStore.getState().settings),
    ) as AppSettings;
    act(() => {
      tree = create(<FocusScreen />);
    });
    act(() => {
      findButtonByText(tree, 'Desk phone urgent').props.onPress();
    });

    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id),
    ).toEqual(['matching-task']);

    act(() => {
      tree.update(<View testID="navigated-away" />);
    });
    expect(tree.root.findAllByType(Modal)).toHaveLength(0);
    actualCore.resetForTests();
    actualCore.setStorageAdapter(actualCore.noopStorage);
  });

  it('hides the Focus location filter when active tasks do not use locations', () => {
    storeState.tasks = [
      makeTask('plain-next', { title: 'Plain next' }),
      makeTask('another-next', { title: 'Another next' }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    act(() => {
      findButtonByLabel(tree, 'Filters').props.onPress();
    });

    expect(tree.root.findAllByProps({ accessibilityLabel: 'Location' })).toHaveLength(0);
  });

  it('filters Focus tasks by location from the filter sheet', async () => {
    storeState.tasks = [
      makeTask('office-task', { title: 'Office task', location: 'Main Office' }),
      makeTask('home-task', { title: 'Home task', location: 'Home' }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    act(() => {
      findButtonByLabel(tree, 'Filters').props.onPress();
    });

    const locationInput = tree.root.findByProps({ accessibilityLabel: 'Location' });
    await act(async () => {
      locationInput.props.onChangeText('office');
    });

    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id),
    ).toEqual(['office-task']);
    expect(textContent(findButtonByText(tree, 'Location: office'))).toContain('Location: office');
  });

  it('orders the Today\'s Focus section by focusOrder in the default sort', () => {
    storeState.tasks = [
      makeTask('focus-c', { title: 'C', isFocusedToday: true, focusOrder: 2 }),
      makeTask('focus-a', { title: 'A', isFocusedToday: true, focusOrder: 0 }),
      makeTask('focus-b', { title: 'B', isFocusedToday: true, focusOrder: 1 }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id),
    ).toEqual(['focus-a', 'focus-b', 'focus-c']);
  });

  it('drags from the whole reorder row with context, lift haptics, and no handle divider', () => {
    storeState.tasks = [
      makeTask('focus-a', {
        title: 'Client call',
        projectId: 'project-a',
        dueDate: '2026-04-17T14:00:00.000Z',
        isFocusedToday: true,
        focusOrder: 0,
      }),
      makeTask('focus-b', { title: 'B', isFocusedToday: true, focusOrder: 1 }),
      makeTask('focus-c', { title: 'C', isFocusedToday: true, focusOrder: 2 }),
    ];
    storeState.projects = [makeProject('project-a', { title: 'Launch' })];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    act(() => {
      tree.root.findByProps({ testID: 'focus-reorder-toggle' }).props.onPress();
    });

    const list = tree.root.findByProps({ testID: 'focus-reorder-list' });
    expect(list.props.data.map((task: Task) => task.id)).toEqual(['focus-a', 'focus-b', 'focus-c']);

    const row = tree.root.findByProps({ testID: 'focus-reorder-row-focus-a' });
    const handle = tree.root.findByProps({ testID: 'focus-reorder-handle-focus-a' });
    const handleStyle = flattenStyle(handle.props.style);
    expect(row.props.delayLongPress).toBe(180);
    expect(row.props.onLongPress).toBe(dragMock);
    expect(textContent(row)).toContain('Launch');
    expect(handle.props.pointerEvents).toBe('none');
    expect(handleStyle.borderLeftWidth).toBeUndefined();
    expect(handleStyle.backgroundColor).toBeUndefined();

    act(() => {
      list.props.onDragBegin(0);
      list.props.onPlaceholderIndexChange(1);
      list.props.onDragEnd({
        data: [{ id: 'focus-c' }, { id: 'focus-a' }, { id: 'focus-b' }],
        from: 2,
        to: 0,
      });
    });

    expect(storeState.reorderFocusedTasks).toHaveBeenCalledTimes(1);
    expect(storeState.reorderFocusedTasks).toHaveBeenCalledWith(['focus-c', 'focus-a', 'focus-b']);
    expect(hapticsMock.impactAsync).toHaveBeenCalledTimes(2);
    expect(hapticsMock.selectionAsync).toHaveBeenCalledTimes(1);
  });

  it('exposes Move up and Move down accessibility actions in reorder mode', () => {
    storeState.tasks = [
      makeTask('focus-a', { title: 'A', isFocusedToday: true, focusOrder: 0 }),
      makeTask('focus-b', { title: 'B {{position}} {{count}}', isFocusedToday: true, focusOrder: 1 }),
      makeTask('focus-c', { title: 'C', isFocusedToday: true, focusOrder: 2 }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });
    act(() => {
      tree.root.findByProps({ testID: 'focus-reorder-toggle' }).props.onPress();
    });

    const row = tree.root.findByProps({ testID: 'focus-reorder-row-focus-b' });
    expect(row.props.accessibilityLabel).toBe('B {{position}} {{count}}. Item 2 of 3');
    expect(row.props.accessibilityHint).toBe('Hold and drag to reorder');
    expect(row.props.accessibilityActions).toEqual([
      { name: 'moveUp', label: 'Move up' },
      { name: 'moveDown', label: 'Move down' },
    ]);
    expect(tree.root.findByProps({ testID: 'focus-reorder-list' }).props.ListFooterComponent.props.children)
      .toBe('Hold and drag to reorder');

    act(() => {
      row.props.onAccessibilityAction({ nativeEvent: { actionName: 'moveUp' } });
    });

    expect(storeState.reorderFocusedTasks).toHaveBeenCalledWith(['focus-b', 'focus-a', 'focus-c']);
  });

  it('uses Android Back as Done while the reorder screen is open', () => {
    storeState.tasks = [
      makeTask('focus-a', { title: 'A', isFocusedToday: true, focusOrder: 0 }),
      makeTask('focus-b', { title: 'B', isFocusedToday: true, focusOrder: 1 }),
    ];
    let backHandler: (() => boolean) | undefined;
    const remove = vi.fn();
    backHandlerMock.mockImplementation((handler: () => boolean) => {
      backHandler = handler;
      return { remove };
    });

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<FocusScreen />);
    });
    act(() => {
      tree.root.findByProps({ testID: 'focus-reorder-toggle' }).props.onPress();
    });

    expect(backHandler).toBeDefined();
    act(() => {
      expect(backHandler?.()).toBe(true);
    });
    expect(tree.root.findAllByProps({ testID: 'focus-reorder-list' })).toHaveLength(0);
  });

  it('hides the reorder toggle when a non-default Focus sort is active', () => {
    storeState.tasks = [
      makeTask('focus-a', { title: 'A', isFocusedToday: true, focusOrder: 0 }),
      makeTask('focus-b', { title: 'B', isFocusedToday: true, focusOrder: 1 }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    expect(tree.root.findAllByProps({ testID: 'focus-reorder-toggle' }).length).toBeGreaterThan(0);

    act(() => {
      findButtonByLabel(tree, 'Filters').props.onPress();
    });
    act(() => {
      findButtonByText(tree, 'due').props.onPress();
    });

    expect(tree.root.findAllByProps({ testID: 'focus-reorder-toggle' })).toHaveLength(0);
  });

  it('hides the reorder toggle when a filter narrows the Focus list', () => {
    // Default sort, but a token filter narrows focusedTasks to a subset;
    // reordering that subset would write focusOrder 0..n over only the visible
    // rows, so the toggle must disappear until the filter clears.
    storeState.tasks = [
      makeTask('focus-a', { title: 'Work focus alpha', isFocusedToday: true, focusOrder: 0, contexts: ['@work'] }),
      makeTask('focus-b', { title: 'Home focus beta', isFocusedToday: true, focusOrder: 1 }),
    ];

    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<FocusScreen />);
    });

    expect(tree.root.findAllByProps({ testID: 'focus-reorder-toggle' }).length).toBeGreaterThan(0);

    act(() => {
      findButtonByLabel(tree, 'Filters').props.onPress();
    });
    act(() => {
      findButtonByText(tree, '@work').props.onPress();
    });

    // The @work task still renders as a non-empty Focus subset, but the toggle
    // is gone because reordering a subset would corrupt the full focusOrder.
    expect(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => node.props.task.id),
    ).toEqual(['focus-a']);
    expect(tree.root.findAllByProps({ testID: 'focus-reorder-toggle' })).toHaveLength(0);
  });


  // The Focus tab is the app's default route, so its rows carry the #766 memo
  // boundary. That boundary only holds if the props Focus hands each row keep
  // their identity across a store write — the row itself is mocked here, so
  // this pins the caller side; the boundary itself is pinned in
  // components/swipeable-task-item.test.tsx.
  it('keeps row props stable for untouched tasks across a store write', () => {
    storeState.tasks = [
      makeTask('row-a', { title: 'Row A' }),
      makeTask('row-b', { title: 'Row B' }),
    ];

    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(<FocusScreen />);
    });

    const propsById = () => new Map(
      tree.root.findAllByType(SwipeableTaskItem).map((node) => [node.props.task.id as string, node.props]),
    );
    const before = propsById();
    expect(before.size).toBe(2);
    expect(before.get('row-b')?.onLongPressAction).toBeTypeOf('function');

    const [rowA, rowB] = storeState.tasks;
    storeState.tasks = [{ ...rowA, title: 'Row A renamed' }, rowB];
    act(() => {
      tree.update(<FocusScreen />);
    });

    const after = propsById();
    expect(after.get('row-a')?.task.title).toBe('Row A renamed');
    expect(after.get('row-b')?.task).toBe(before.get('row-b')?.task);
    expect(after.get('row-b')?.actions).toBe(before.get('row-b')?.actions);
    expect(after.get('row-b')?.onLongPressAction).toBe(before.get('row-b')?.onLongPressAction);
  });

});
