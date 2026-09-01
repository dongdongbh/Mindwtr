import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import renderer from 'react-test-renderer';
import { Alert } from 'react-native';

import { SwipeableTaskItem, readTaskRowRenderCount, type TaskRowActions } from './swipeable-task-item';

const { addTask, updateTask, restoreTask, undoTaskCompletion, showToast, getChecklistProgress, getTaskAgeLabel, getTaskStaleness, safeFormatDate, safeParseDate, storeState } = vi.hoisted(() => ({
  addTask: vi.fn(),
  updateTask: vi.fn(),
  restoreTask: vi.fn(),
  undoTaskCompletion: vi.fn(),
  showToast: vi.fn(),
  getChecklistProgress: vi.fn((_value: any): any => null),
  getTaskAgeLabel: vi.fn(() => '3 weeks old'),
  getTaskStaleness: vi.fn(() => 'stale'),
  safeFormatDate: vi.fn((_value: unknown, formatStr: string): string => (
    formatStr === 'Pp' ? 'May 12, 2026, 8:30 AM' : ''
  )),
  safeParseDate: vi.fn((value?: string | null) => (value ? new Date(value) : null)),
  storeState: {
    addTask: vi.fn(),
    updateTask: vi.fn(),
    updateProject: vi.fn(),
    restoreTask: vi.fn(),
    projects: [] as any[],
    _allProjects: [] as any[],
    _sectionsById: new Map<string, any>(),
    areas: [] as any[],
    settings: { features: {}, appearance: {} },
    getDerivedState: () => ({ focusedCount: 0 }),
    getFocusStarAction: (task: any) => (
      task.isFocusedToday
        ? { isFocused: true, canToggle: true, blockedReason: null, labelKey: 'agenda.removeFromFocus', patch: { isFocusedToday: false } }
        : { isFocused: false, canToggle: true, blockedReason: null, labelKey: 'agenda.addToFocus', patch: { isFocusedToday: true } }
    ),
    tasks: [] as any[],
    _allTasks: [] as any[],
    _tasksById: new Map<string, any>(),
  },
}));
const hapticsMocks = vi.hoisted(() => ({
  impactAsync: vi.fn().mockResolvedValue(undefined),
  notificationAsync: vi.fn().mockResolvedValue(undefined),
}));
const translate = vi.hoisted(() => {
  const labels: Record<string, string> = {
    'common.cancel': 'Cancel',
    'common.delete': 'Delete',
    'common.done': 'Done',
    'common.edit': 'Edit',
    'common.notice': 'Notice',
    'common.skip': 'Skip',
    'common.undo': 'Undo',
    'agenda.addToFocus': 'Add to focus',
    'agenda.removeFromFocus': 'Remove from focus',
    'list.taskDeleted': 'Task deleted',
    'list.done': 'Completed',
    'status.inbox': 'Inbox',
    'status.done': 'Done',
    'status.next': 'Next',
    'status.waiting': 'Waiting',
    'status.someday': 'Someday',
    'status.reference': 'Reference',
    'taskStatus.changeStatus': 'Change Status',
    'projects.nextActionPromptTitle': "What's the next action?",
    'projects.nextActionPromptDesc': 'Choose or add the next action for {{project}}.',
    'projects.nextActionPromptChooseExisting': 'Choose an existing task',
    'projects.nextActionPromptAddNew': 'Add a new next action',
    'projects.nextActionPromptPlaceholder': 'New next action...',
    'projects.nextActionPromptAddButton': 'Add next action',
    'projects.nextActionPromptComplete': 'Complete project',
    'task.aria.delete': 'Delete task',
    'task.aria.actionsHint': 'Double-tap to edit task details. More actions are available in the accessibility actions menu.',
    'task.aria.selectionHint': 'Double-tap to toggle task selection.',
    'task.aria.openProject': 'Open project {name}',
    'task.aria.openContext': 'Open context {name}',
    'task.aria.openTag': 'Open tag {name}',
    'task.aria.action': '{action} action',
    'task.aria.changeStatus': 'Change status. Current status: {status}',
    'task.aria.changeStatusHint': 'Double-tap to open status menu',
    'task.select': 'Select task',
    'task.deselect': 'Deselect task',
    'taskEdit.statusLabel': 'Status',
    'taskEdit.priorityLabel': 'Priority',
    'priority.low': 'Low',
    'priority.medium': 'Medium',
    'priority.high': 'High',
    'priority.urgent': 'Urgent',
    'taskEdit.dueDateLabel': 'Due',
    'task.deleteConfirmBody': 'Move this task to Trash?',
    'taskEdit.recurrenceLabel': 'Recurrence',
    'taskEdit.startDateLabel': 'Start',
    'recurrence.daily': 'Daily',
    'recurrence.repeatEvery': 'Repeat every',
    'recurrence.dayUnit': 'day(s)',
  };
  const translator = ((key: string) => translator.overrides[key] ?? labels[key] ?? key) as (
    ((key: string) => string) & { overrides: Record<string, string> }
  );
  translator.overrides = {};
  return translator;
});

vi.mock('@mindwtr/core', async (importOriginal) => {
  const { mockCore } = await import('../test-support/mock-core');
  storeState.addTask = addTask;
  storeState.updateTask = updateTask;
  storeState.restoreTask = restoreTask;
  // Only display formatters are doubled, so rendered text stays deterministic.
  // Everything else is real core on purpose: the stubs this replaced included a
  // `getTaskDateCoherenceIssues` hardcoded to one fixture's dates.
  return mockCore(importOriginal, () => storeState, {
    getChecklistProgress,
    getTaskAgeLabel,
    getTaskStaleness,
    safeFormatDate,
    safeParseDate,
    undoTaskCompletion,
  });
});

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({
    language: 'en',
    t: translate,
  }),
}));

vi.mock('@/contexts/language-context', () => ({
  useLanguage: () => ({
    language: 'en',
    t: translate,
  }),
}));

vi.mock('react-native-gesture-handler', () => ({
  Swipeable: ({ renderLeftActions, renderRightActions, children, ...props }: any) =>
    React.createElement(
      'Swipeable',
      props,
      renderLeftActions ? renderLeftActions() : null,
      renderRightActions ? renderRightActions() : null,
      children
    ),
}));

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: {
    Medium: 'medium',
  },
  NotificationFeedbackType: {
    Success: 'success',
    Warning: 'warning',
  },
  impactAsync: hapticsMocks.impactAsync,
  notificationAsync: hapticsMocks.notificationAsync,
}));

vi.mock('./completed-at-picker', () => ({
  CompletedAtPicker: (props: any) => React.createElement('CompletedAtPicker', props),
}));

vi.mock('expo-linking', () => ({
  openURL: vi.fn(),
}));

vi.mock('@react-native-community/datetimepicker', () => ({
  __esModule: true,
  default: () => null,
}));

vi.mock('expo-clipboard', () => ({
  setStringAsync: vi.fn(async () => {}),
}));

vi.mock('@/lib/task-meta-navigation', () => ({
  openProjectScreen: vi.fn(),
  openTaskScreen: vi.fn(),
}));

vi.mock('../contexts/toast-context', () => ({
  ToastViewport: () => null,
  useToast: () => ({
    showToast,
    dismissToast: vi.fn(),
  }),
}));

vi.mock('../hooks/use-theme-tokens', () => ({
  useThemeTokens: () => ({
    isMaterial: false,
    shape: { large: 16 },
    state: { rippleColor: undefined, stateLayerColor: () => 'transparent' },
  }),
}));

vi.mock('lucide-react-native', () => ({
  ArrowRight: (props: any) => React.createElement('ArrowRight', props),
  Check: (props: any) => React.createElement('Check', props),
  CircleDot: (props: any) => React.createElement('CircleDot', props),
  History: (props: any) => React.createElement('History', props),
  ListChecks: (props: any) => React.createElement('ListChecks', props),
  Repeat: (props: any) => React.createElement('Repeat', props),
  RotateCcw: (props: any) => React.createElement('RotateCcw', props),
  Star: (props: any) => React.createElement('Star', props),
  Trash2: (props: any) => React.createElement('Trash2', props),
}));

describe('SwipeableTaskItem', () => {
  const flattenText = (value: unknown): string => {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.map((item) => flattenText(item)).join('');
    if (value && typeof value === 'object') {
      const item = value as { children?: unknown; props?: { children?: unknown } };
      return flattenText(item.props?.children ?? item.children);
    }
    return '';
  };

  const hasText = (tree: renderer.ReactTestRenderer, text: string) =>
    tree.root.findAll((node) => flattenText(node.props?.children).includes(text)).length > 0;

  const flattenStyle = (style: unknown): Record<string, unknown> => {
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
  };

  const getTextColor = (tree: renderer.ReactTestRenderer, text: string) => {
    const matches = tree.root.findAll((node) => (
      flattenText(node.props?.children) === text && node.props?.style
    ));
    const node = matches[matches.length - 1];
    return flattenStyle(node?.props.style).color;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    translate.overrides = {};
    storeState.projects = [];
    storeState._allProjects = [];
    storeState._sectionsById = new Map();
    storeState.areas = [];
    storeState.settings = { features: {}, appearance: {} };
    storeState.tasks = [];
    storeState._allTasks = [];
    storeState._tasksById = new Map();
    addTask.mockResolvedValue({ success: true, id: 'created-task' });
    updateTask.mockResolvedValue({ success: true });
    restoreTask.mockResolvedValue({ success: true });
    undoTaskCompletion.mockResolvedValue(undefined);
    getTaskAgeLabel.mockReturnValue('3 weeks old');
    getTaskStaleness.mockReturnValue('stale');
    getChecklistProgress.mockReturnValue(null);
    safeFormatDate.mockImplementation((_value: unknown, formatStr: string) => (
      formatStr === 'Pp' ? 'May 12, 2026, 8:30 AM' : ''
    ));
    safeParseDate.mockImplementation((value?: string | null) => (value ? new Date(value) : null));
  });

  it('keeps inbox row titles width-constrained without the focus toggle', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Do laundry',
            status: 'inbox',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
          statusBadgeAsIcon
        />
      );
    });

    const title = tree.root.findAll((node) => (
      flattenText(node.props?.children) === 'Do laundry' && node.props?.style
    )).at(-1);

    expect(title).toBeTruthy();
    expect(flattenStyle(title?.props.style)).toEqual(expect.objectContaining({
      flex: 1,
      minWidth: 0,
    }));
  });

  it('requires a deliberate horizontal drag before opening swipe actions', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Pay rent',
            status: 'inbox',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
        />
      );
    });

    const swipeable = tree.root.find((node) => (node.type as unknown) === 'Swipeable');
    expect(swipeable.props.friction).toBe(1.25);
    expect(swipeable.props.leftThreshold).toBe(72);
    expect(swipeable.props.rightThreshold).toBe(72);
    expect(swipeable.props.dragOffsetFromLeftEdge).toBe(28);
    expect(swipeable.props.dragOffsetFromRightEdge).toBe(28);
    expect(swipeable.props.overshootLeft).toBe(false);
    expect(swipeable.props.overshootRight).toBe(false);
  });

it('uses the shared rounded star treatment for focused tasks', () => {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(
      <SwipeableTaskItem
        task={{
          id: 'task-1',
          title: 'File taxes',
          status: 'next',
          isFocusedToday: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        } as any}
        isDark={true}
        tc={{
          taskItemBg: '#111111',
          border: '#222222',
          text: '#ffffff',
          secondaryText: '#999999',
          tint: '#3b82f6',
          warning: '#f59e0b',
        } as any}
        onPress={vi.fn()}
        onStatusChange={vi.fn()}
        onDelete={vi.fn()}
        showFocusToggle
      />
    );
  });

  const focusButton = tree.root.find((node) => node.props.accessibilityLabel === 'Remove from focus');
  const focusButtonStyle = Array.isArray(focusButton.props.style)
    ? Object.assign({}, ...focusButton.props.style.filter(Boolean))
    : focusButton.props.style;
  expect(focusButtonStyle).not.toHaveProperty('backgroundColor');
  expect(hasText(tree, '★')).toBe(false);

  const star = tree.root.find((node) => (node.type as unknown) === 'Star');
  expect(star.props.color).toBe('#F59E0B');
  expect(star.props.fill).toBe('#F59E0B');
  expect(star.props.strokeWidth).toBe(2);
});

it('renders the focus star disabled with its reason when the caller blocks it', () => {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(
      <SwipeableTaskItem
        task={{
          id: 'task-1',
          title: 'File taxes',
          status: 'next',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        } as any}
        isDark={true}
        tc={{
          taskItemBg: '#111111',
          border: '#222222',
          text: '#ffffff',
          secondaryText: '#999999',
          tint: '#3b82f6',
          warning: '#f59e0b',
        } as any}
        onPress={vi.fn()}
        onStatusChange={vi.fn()}
        onDelete={vi.fn()}
        showFocusToggle
        focusToggleDisabledLabel="This task is deferred"
      />
    );
  });

  const focusButton = tree.root.find((node) => node.props.accessibilityLabel === 'This task is deferred');
  expect(focusButton.props.disabled).toBe(true);
  expect(focusButton.props.accessibilityState).toEqual({ disabled: true });
});

it('can keep the focus star without adding a redundant focus outline', () => {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(
      <SwipeableTaskItem
        task={{
          id: 'task-1',
          title: 'File taxes',
          status: 'next',
          isFocusedToday: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        } as any}
        isDark={true}
        tc={{
          taskItemBg: '#111111',
          border: '#222222',
          text: '#ffffff',
          secondaryText: '#999999',
          tint: '#3b82f6',
          warning: '#f59e0b',
        } as any}
        onPress={vi.fn()}
        onStatusChange={vi.fn()}
        onDelete={vi.fn()}
        showFocusToggle
        showFocusHighlight={false}
      />
    );
  });

  const taskButton = tree.root.find((node) => (
    node.props.accessibilityRole === 'button'
    && typeof node.props.accessibilityLabel === 'string'
    && node.props.accessibilityLabel.includes('File taxes')
  ));
  const style = flattenStyle(taskButton.props.style);
  expect(style.borderColor).toBe('#222222');
  expect(style.borderWidth).not.toBe(2);
  expect(tree.root.find((node) => node.props.accessibilityLabel === 'Remove from focus')).toBeTruthy();
});

  it('deletes immediately with an undo toast instead of a confirmation', async () => {
    const alertSpy = vi.spyOn(Alert, 'alert');
    const onDelete = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Pay rent',
            status: 'inbox',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={onDelete}
        />
      );
    });

    const deleteAction = tree.root.find(
      (node) => node.props.accessibilityLabel === 'Delete task' && typeof node.props.onPress === 'function'
    );

    renderer.act(() => {
      deleteAction.props.onPress();
    });

    // Deleting moves the task to Trash immediately; the undo toast replaces a
    // confirmation prompt.
    expect(alertSpy).not.toHaveBeenCalled();

    await renderer.act(async () => {
      await Promise.resolve();
    });

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(hapticsMocks.notificationAsync).toHaveBeenCalledWith('warning');
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Task deleted',
      actionLabel: 'Undo',
      onAction: expect.any(Function),
    }));
  });

  it('does not report delete success when the action resolves to a failure', async () => {
    const onDelete = vi.fn(async () => ({ success: false, error: 'Storage is read-only' }));
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Pay rent',
            status: 'inbox',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={onDelete}
        />
      );
    });

    const deleteAction = tree.root.find(
      (node) => node.props.accessibilityLabel === 'Delete task' && typeof node.props.onPress === 'function'
    );
    await renderer.act(async () => {
      deleteAction.props.onPress();
      await Promise.resolve();
    });

    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Storage is read-only',
      tone: 'error',
    }));
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'Task deleted' }));
  });

  it('surfaces resolved failures from delete undo and focus-star actions', async () => {
    const onDelete = vi.fn(async () => ({ success: true }));
    restoreTask.mockResolvedValueOnce({ success: false, error: 'Restore failed' });
    updateTask.mockResolvedValueOnce({ success: false, error: 'Focus update failed' });
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Pay rent',
            status: 'inbox',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={onDelete}
          showFocusToggle
        />
      );
    });

    const deleteAction = tree.root.find(
      (node) => node.props.accessibilityLabel === 'Delete task' && typeof node.props.onPress === 'function'
    );
    await renderer.act(async () => {
      deleteAction.props.onPress();
      await Promise.resolve();
    });
    const undo = showToast.mock.calls.find(([toast]) => toast.message === 'Task deleted')?.[0]?.onAction;
    await renderer.act(async () => {
      undo?.();
      await Promise.resolve();
    });

    const focus = tree.root.find((node) => node.props.accessibilityLabel === 'Add to focus');
    await renderer.act(async () => {
      focus.props.onPress({ stopPropagation: vi.fn() });
      await Promise.resolve();
    });

    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Restore failed',
      tone: 'error',
    }));
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Focus update failed',
      tone: 'error',
    }));
  });

  it('exposes the long-press row action through accessibility actions', () => {
    const onLongPressAction = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Plan release',
            status: 'next',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
          onLongPressAction={onLongPressAction}
          onLongPressActionLabel="Defer until"
        />
      );
    });

    const row = tree.root.find((node) => (
      node.props.accessibilityLabel === 'Plan release. Status: Next'
      && Array.isArray(node.props.accessibilityActions)
    ));

    expect(row.props.accessibilityActions).toEqual(expect.arrayContaining([
      { name: 'longPressAction', label: 'Defer until' },
    ]));

    renderer.act(() => {
      row.props.onAccessibilityAction({ nativeEvent: { actionName: 'longPressAction' } });
    });

    expect(onLongPressAction).toHaveBeenCalledTimes(1);
  });

  it('shows recurring task metadata in the mobile row', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Water plants',
            status: 'next',
            recurrence: { rule: 'daily', rrule: 'FREQ=DAILY;INTERVAL=3' },
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
        />
      );
    });

    expect(hasText(tree, 'Daily · Repeat every 3 day(s)')).toBe(true);
    expect(tree.root.findAll((node) => (node.type as unknown) === 'Repeat')).toHaveLength(1);
    expect(tree.root.findAll((node) => (
      node.props.accessibilityLabel === 'Water plants. Status: Next. Recurrence: Daily · Repeat every 3 day(s)'
      && Array.isArray(node.props.accessibilityActions)
    )).length).toBeGreaterThan(0);
  });

  it('shows time spent in the mobile row when pomodoro task linking is enabled', () => {
    storeState.settings = {
      features: { pomodoro: true },
      gtd: { pomodoro: { linkTask: true } },
      appearance: {},
    } as any;
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Write report',
            status: 'next',
            timeSpentMinutes: 65,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
        />
      );
    });

    expect(hasText(tree, '1h 5m')).toBe(true);
    expect(tree.root.findAll((node) => (node.type as unknown) === 'History')).toHaveLength(1);
  });

  it('hides time spent in the mobile row when pomodoro task linking is disabled', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Write report',
            status: 'next',
            timeSpentMinutes: 65,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
        />
      );
    });

    expect(hasText(tree, '1h 5m')).toBe(false);
  });

  it('uses long press to toggle selection when no custom long-press action is present', () => {
    const onToggleSelect = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Plan release',
            status: 'next',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
          onToggleSelect={onToggleSelect}
        />
      );
    });

    const row = tree.root.find((node) => (
      node.props.accessibilityLabel === 'Plan release. Status: Next'
      && typeof node.props.onLongPress === 'function'
    ));

    renderer.act(() => {
      row.props.onLongPress();
    });

    expect(onToggleSelect).toHaveBeenCalledTimes(1);
  });

  it('shows a date-coherence indicator when a task starts after its due date', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Plan release',
            status: 'next',
            dueDate: '2026-04-24',
            startTime: '2026-04-25',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
        />
      );
    });

    expect(hasText(tree, 'Starts after due date')).toBe(true);
  });

  it('shows scheduled date and time metadata for tasks with a start time', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Client call',
            status: 'next',
            startTime: '2026-05-12T08:30:00.000Z',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
        />
      );
    });

    expect(hasText(tree, 'Start: May 12, 2026, 8:30 AM')).toBe(true);

    const row = tree.root.find((node) => (
      node.props.accessibilityRole === 'button'
      && node.props.accessibilityLabel === 'Client call. Status: Next. Start: May 12, 2026, 8:30 AM'
    ));
    expect(row).toBeTruthy();
    expect(safeFormatDate).toHaveBeenCalledWith(expect.any(Date), 'Pp');
  });

  // Urgency is derived by core from the due date against the clock — there is no
  // `urgency` field on Task. This test used to set one and the core mock echoed
  // it back, so every case shared a single past due date and the assertion only
  // ever proved the stub returned what it was handed.
  it('colors due date metadata by urgency', () => {
    safeFormatDate.mockReturnValue('Due date');
    const hoursFromNow = (hours: number) => (
      new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
    );
    const renderDueTask = (label: string, dueDate: string) => {
      let tree!: renderer.ReactTestRenderer;
      renderer.act(() => {
        tree = renderer.create(
          <SwipeableTaskItem
            task={{
              id: `task-${label}`,
              title: 'Plan release',
              status: 'next',
              dueDate,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            } as any}
            isDark={false}
            tc={{
              taskItemBg: '#111111',
              border: '#222222',
              text: '#ffffff',
              secondaryText: '#999999',
              tint: '#3b82f6',
              warning: '#f59e0b',
              danger: '#b91c1c',
            } as any}
            onPress={vi.fn()}
            onStatusChange={vi.fn()}
            onDelete={vi.fn()}
          />
        );
      });
      return tree;
    };

    expect(getTextColor(renderDueTask('normal', hoursFromNow(24 * 10)), 'Due date')).toBe('#999999');
    expect(getTextColor(renderDueTask('upcoming', hoursFromNow(48)), 'Due date')).toBe('#f59e0b');
    expect(getTextColor(renderDueTask('urgent', hoursFromNow(12)), 'Due date')).toBe('#f59e0b');
    expect(getTextColor(renderDueTask('overdue', hoursFromNow(-24)), 'Due date')).toBe('#b91c1c');
  });

  it('navigates from project, context, and tag meta labels', () => {
    const onProjectPress = vi.fn();
    const onContextPress = vi.fn();
    const onTagPress = vi.fn();
    storeState.projects = [
      { id: 'project-1', title: 'Mindwtr', areaId: undefined },
    ];
    storeState._sectionsById = new Map([
      ['section-1', { id: 'section-1', projectId: 'project-1', title: 'Release checklist' }],
    ]);

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Plan release',
            status: 'inbox',
            projectId: 'project-1',
            sectionId: 'section-1',
            contexts: ['@work'],
            tags: ['#urgent'],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
          onProjectPress={onProjectPress}
          onContextPress={onContextPress}
          onTagPress={onTagPress}
        />
      );
    });

    const projectButton = tree.root.find((node) => (
      node.props.accessibilityLabel === 'Open project Mindwtr · Release checklist'
    ));
    const contextButton = tree.root.find((node) => node.props.accessibilityLabel === 'Open context @work');
    const tagButton = tree.root.find((node) => node.props.accessibilityLabel === 'Open tag #urgent');

    expect(hasText(tree, 'Mindwtr · Release checklist')).toBe(true);

    renderer.act(() => {
      projectButton.props.onPress({ stopPropagation: vi.fn() });
      contextButton.props.onPress({ stopPropagation: vi.fn() });
      tagButton.props.onPress({ stopPropagation: vi.fn() });
    });

    expect(onProjectPress).toHaveBeenCalledWith('project-1');
    expect(onContextPress).toHaveBeenCalledWith('@work');
    expect(onTagPress).toHaveBeenCalledWith('#urgent');
  });

  it('can hide project meta when the task is already shown inside that project', () => {
    storeState.projects = [
      { id: 'project-1', title: 'Mindwtr', areaId: undefined },
    ];

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Plan release',
            status: 'next',
            projectId: 'project-1',
            contexts: ['@work'],
            tags: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
          hideProjectMeta
        />
      );
    });

    expect(() => tree.root.find((node) => node.props.accessibilityLabel === 'Open project Mindwtr')).toThrow();
    expect(hasText(tree, '@work')).toBe(true);
  });

  it('hides stale task age when the appearance setting is off by default', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Defer filing',
            status: 'inbox',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
        />
      );
    });

    expect(hasText(tree, '3 weeks old')).toBe(false);
  });

  it('shows task age when enabled in appearance settings', () => {
    storeState.settings = { features: {}, appearance: { showTaskAge: true } };
    getTaskAgeLabel.mockReturnValue('2 days old');
    getTaskStaleness.mockReturnValue('fresh');

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Defer filing',
            status: 'inbox',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
        />
      );
    });

    expect(hasText(tree, '2 days old')).toBe(true);
  });

  it('renders compact description markdown without raw block or inline markers', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Prepare notes',
            description: '# Review **draft** [spec](https://example.com)',
            status: 'inbox',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            cardBg: '#111111',
            filterBg: '#222222',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
        />
      );
    });

    const renderedText = flattenText(tree.toJSON());
    expect(renderedText).toContain('Review draft spec');
    expect(renderedText).not.toContain('# Review');
    expect(renderedText).not.toContain('**draft**');
    expect(renderedText).not.toContain('](');
  });

  it('renders title-only with hideDetails, hiding the description preview and metadata parts', () => {
    const renderRow = (hideDetails: boolean) => {
      let tree!: renderer.ReactTestRenderer;
      renderer.act(() => {
        tree = renderer.create(
          <SwipeableTaskItem
            task={{
              id: 'task-1',
              title: 'Client call',
              description: 'Prep the deck',
              status: 'next',
              startTime: '2026-05-12T08:30:00.000Z',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            } as any}
            isDark={false}
            tc={{
              taskItemBg: '#111111',
              border: '#222222',
              text: '#ffffff',
              secondaryText: '#999999',
              tint: '#3b82f6',
              warning: '#f59e0b',
            } as any}
            onPress={vi.fn()}
            onStatusChange={vi.fn()}
            onDelete={vi.fn()}
            hideDetails={hideDetails}
          />
        );
      });
      return tree;
    };

    const shown = renderRow(false);
    expect(hasText(shown, 'Client call')).toBe(true);
    expect(hasText(shown, 'Prep the deck')).toBe(true);
    expect(hasText(shown, 'Start: May 12, 2026, 8:30 AM')).toBe(true);

    const hidden = renderRow(true);
    expect(hasText(hidden, 'Client call')).toBe(true);
    expect(hasText(hidden, 'Prep the deck')).toBe(false);
    expect(hasText(hidden, 'Start: May 12, 2026, 8:30 AM')).toBe(false);
  });

  it('shows the completion date and time for completed tasks', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'File receipts',
            status: 'done',
            completedAt: '2026-05-12T08:30:00.000Z',
            createdAt: '2026-05-01T08:30:00.000Z',
            updatedAt: '2026-05-12T08:30:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
        />
      );
    });

    expect(hasText(tree, 'Completed: May 12, 2026, 8:30 AM')).toBe(true);
  });

  it('announces the localized accessibility action menu and triggers status actions', () => {
    const onStatusChange = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Plan release',
            status: 'inbox',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={onStatusChange}
          onDelete={vi.fn()}
        />
      );
    });

    const taskButton = tree.root.find((node) => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel?.includes('Status: Inbox'));
    const nextAction = tree.root.find((node) => node.props.accessibilityLabel === 'Next action' && typeof node.props.onPress === 'function');

    expect(taskButton.props.accessibilityHint).toBe(
      'Double-tap to edit task details. More actions are available in the accessibility actions menu.'
    );
    expect(taskButton.props.accessibilityHint).not.toContain('Swipe right');

    renderer.act(() => {
      nextAction.props.onPress();
    });

    expect(onStatusChange).toHaveBeenCalledWith('next');
    expect(hapticsMocks.notificationAsync).toHaveBeenCalledWith('success');
  });

  it('uses localized status, due-date, and action-menu accessibility copy', () => {
    translate.overrides = {
      'task.aria.actionsHint': 'Touchez deux fois pour modifier. Les autres actions sont dans le menu.',
      'taskEdit.statusLabel': 'Statut',
      'taskEdit.dueDateLabel': 'Échéance',
      'status.next': 'Suivante',
    };
    safeFormatDate.mockReturnValue('12 mai 2026');

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-localized-a11y',
            title: 'Préparer le lancement',
            status: 'next',
            dueDate: '2026-05-12',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
        />
      );
    });

    const taskButton = tree.root.find((node) => (
      node.props.accessibilityRole === 'button'
      && node.props.accessibilityLabel?.includes('Statut: Suivante')
    ));
    expect(taskButton.props.accessibilityLabel).toContain('Échéance: 12 mai 2026');
    expect(taskButton.props.accessibilityHint).toBe(
      'Touchez deux fois pour modifier. Les autres actions sont dans le menu.'
    );
  });

  it('localizes metadata links, the status control, and revealed swipe actions', () => {
    translate.overrides = {
      'task.aria.openProject': 'Ouvrir le projet {name}',
      'task.aria.openContext': 'Ouvrir le contexte {name}',
      'task.aria.openTag': 'Ouvrir le tag {name}',
      'task.aria.action': 'Action : {action}',
      'task.aria.changeStatus': 'Changer le statut. Statut actuel : {status}',
      'task.aria.changeStatusHint': 'Touchez deux fois pour ouvrir le menu des statuts',
      'status.inbox': 'Boite de reception',
      'status.next': 'Suivante',
    };
    storeState.projects = [{ id: 'project-1', title: 'Mindwtr' }];

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-localized-controls',
            title: 'Preparer le lancement',
            status: 'inbox',
            projectId: 'project-1',
            contexts: ['@travail'],
            tags: ['#urgent'],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
          onProjectPress={vi.fn()}
          onContextPress={vi.fn()}
          onTagPress={vi.fn()}
        />
      );
    });

    expect(tree.root.findByProps({ accessibilityLabel: 'Ouvrir le projet Mindwtr' })).toBeDefined();
    expect(tree.root.findByProps({ accessibilityLabel: 'Ouvrir le contexte @travail' })).toBeDefined();
    expect(tree.root.findByProps({ accessibilityLabel: 'Ouvrir le tag #urgent' })).toBeDefined();
    expect(tree.root.findByProps({ accessibilityLabel: 'Action : Suivante' })).toBeDefined();
    const statusButton = tree.root.findByProps({
      accessibilityLabel: 'Changer le statut. Statut actuel : Boite de reception',
    });
    expect(statusButton.props.accessibilityHint).toBe(
      'Touchez deux fois pour ouvrir le menu des statuts'
    );
  });

  it('announces selection-mode activation as selecting or deselecting the task', () => {
    translate.overrides = {
      'task.select': 'Choisir la tache',
      'task.deselect': 'Retirer la selection',
      'task.aria.selectionHint': 'Touchez deux fois pour changer la selection.',
    };
    const onToggleSelect = vi.fn();
    const renderSelected = (isMultiSelected: boolean) => renderer.create(
      <SwipeableTaskItem
        task={{
          id: 'task-selection-a11y',
          title: 'Preparer le lancement',
          status: 'inbox',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        } as any}
        isDark={false}
        tc={{
          taskItemBg: '#111111',
          border: '#222222',
          text: '#ffffff',
          secondaryText: '#999999',
          tint: '#3b82f6',
          warning: '#f59e0b',
        } as any}
        onPress={vi.fn()}
        onStatusChange={vi.fn()}
        onDelete={vi.fn()}
        selectionMode
        isMultiSelected={isMultiSelected}
        onToggleSelect={onToggleSelect}
      />
    );

    let unselectedTree!: renderer.ReactTestRenderer;
    let selectedTree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      unselectedTree = renderSelected(false);
      selectedTree = renderSelected(true);
    });
    const findTaskButton = (tree: renderer.ReactTestRenderer) => tree.root.find((node) => (
      node.props.accessibilityRole === 'button'
      && node.props.accessibilityLabel?.includes('Preparer le lancement')
    ));
    const unselectedButton = findTaskButton(unselectedTree);
    const selectedButton = findTaskButton(selectedTree);

    expect(unselectedButton.props.accessibilityHint).toBe(
      'Touchez deux fois pour changer la selection.'
    );
    expect(unselectedButton.props.accessibilityActions).toEqual([
      { name: 'activate', label: 'Choisir la tache' },
    ]);
    expect(unselectedButton.props.accessibilityState).toEqual({ selected: false });
    expect(selectedButton.props.accessibilityActions).toEqual([
      { name: 'activate', label: 'Retirer la selection' },
    ]);
    expect(selectedButton.props.accessibilityState).toEqual({ selected: true });

    renderer.act(() => {
      unselectedButton.props.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } });
    });
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
  });

  it('saves completion time and time spent from the revealed Done action', async () => {
    const onStatusChange = vi.fn();
    const completedAt = '2026-07-14T18:30:00.000Z';
    storeState.settings = {
      features: { pomodoro: true },
      appearance: {},
      gtd: { pomodoro: { linkTask: true } },
    } as any;

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Plan release',
            status: 'next',
            timeSpentMinutes: 15,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={onStatusChange}
          onDelete={vi.fn()}
        />
      );
    });

    const doneAction = tree.root.find((node) => (
      node.props.accessibilityLabel === 'Done action' && typeof node.props.onLongPress === 'function'
    ));

    renderer.act(() => {
      doneAction.props.onLongPress();
    });

    expect(hapticsMocks.impactAsync).toHaveBeenCalledWith('medium');
    expect(doneAction.props.accessibilityHint).toBe('Long-press to complete with a different time');

    const picker = tree.root.findByType('CompletedAtPicker' as any);
    expect(picker.props.showTimeSpent).toBe(true);
    expect(picker.props.initialTimeSpentMinutes).toBe(15);
    await renderer.act(async () => {
      picker.props.onConfirm(completedAt, 45);
      await Promise.resolve();
    });

    expect(updateTask).toHaveBeenCalledWith('task-1', {
      status: 'done',
      completedAt,
      timeSpentMinutes: 45,
    });
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it('offers reference in the mobile status menu', () => {
    const onStatusChange = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Keep notes',
            status: 'inbox',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            cardBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={onStatusChange}
          onDelete={vi.fn()}
        />
      );
    });

    const statusBadge = tree.root.find(
      (node) => node.props.accessibilityLabel === 'Change status. Current status: Inbox'
    );
    renderer.act(() => {
      statusBadge.props.onPress({ stopPropagation: vi.fn() });
    });

    expect(hasText(tree, 'Reference')).toBe(true);

    const referenceAction = tree.root.find(
      (node) => node.props.accessibilityLabel === 'Reference' && typeof node.props.onPress === 'function'
    );
    renderer.act(() => {
      referenceAction.props.onPress();
    });

    expect(onStatusChange).toHaveBeenCalledWith('reference');
  });

  it('renders the status control as an icon button on single-status lists and still opens the menu', () => {
    const onStatusChange = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={{
            id: 'task-1',
            title: 'Capture idea',
            status: 'inbox',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as any}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            cardBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={onStatusChange}
          onDelete={vi.fn()}
          statusBadgeAsIcon
        />
      );
    });

    // Icon variant renders the status dot, not the redundant "Inbox" label.
    expect(tree.root.findAll((node) => (node.type as unknown) === 'CircleDot')).toHaveLength(1);
    const statusControl = tree.root.find(
      (node) => node.props.accessibilityLabel === 'Change status. Current status: Inbox'
    );
    expect(flattenText(statusControl.props.children)).not.toContain('Inbox');

    // Tapping the icon still opens the quick-status menu.
    renderer.act(() => {
      statusControl.props.onPress({ stopPropagation: vi.fn() });
    });
    expect(hasText(tree, 'Change Status')).toBe(true);

    const nextAction = tree.root.find(
      (node) => node.props.accessibilityLabel === 'Next' && typeof node.props.onPress === 'function'
    );
    renderer.act(() => {
      nextAction.props.onPress();
    });
    expect(onStatusChange).toHaveBeenCalledWith('next');
  });

  it('prompts for the project next action after completing the last next task', async () => {
    const project = { id: 'project-1', title: 'Launch plan', status: 'active' };
    const task = {
      id: 'task-1',
      title: 'Finish current step',
      status: 'next',
      projectId: 'project-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as any;
    const candidate = {
      id: 'task-2',
      title: 'Draft follow-up',
      status: 'someday',
      projectId: 'project-1',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    } as any;
    storeState.projects = [project];
    storeState._allProjects = [project];
    storeState._allTasks = [task, candidate];
    storeState._tasksById = new Map([[task.id, task], [candidate.id, candidate]]);
    const onStatusChange = vi.fn((status: string) => {
      const updatedTask = { ...task, status };
      storeState._allTasks = [updatedTask, candidate];
      storeState._tasksById = new Map([[updatedTask.id, updatedTask], [candidate.id, candidate]]);
    });

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={task}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            onTint: '#ffffff',
            inputBg: '#222222',
            filterBg: '#333333',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={onStatusChange}
          onDelete={vi.fn()}
        />
      );
    });

    const doneAction = tree.root.find((node) => node.props.accessibilityLabel === 'Done action' && typeof node.props.onPress === 'function');
    await renderer.act(async () => {
      doneAction.props.onPress();
      await Promise.resolve();
    });

    expect(hasText(tree, "What's the next action?")).toBe(true);
    expect(hasText(tree, 'Draft follow-up')).toBe(true);

    const candidateAction = tree.root.find((node) => node.props.accessibilityLabel === 'Draft follow-up' && typeof node.props.onPress === 'function');
    await renderer.act(async () => {
      candidateAction.props.onPress();
      await Promise.resolve();
    });

    expect(updateTask).toHaveBeenCalledWith('task-2', { status: 'next' });
  });

  it('does not open the next-action prompt when the completion update fails', async () => {
    const project = { id: 'project-1', title: 'Launch plan', status: 'active' };
    const task = {
      id: 'task-1',
      title: 'Finish current step',
      status: 'next',
      projectId: 'project-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as any;
    const candidate = {
      id: 'task-2',
      title: 'Draft follow-up',
      status: 'someday',
      projectId: 'project-1',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    } as any;
    storeState.projects = [project];
    storeState._allProjects = [project];
    storeState._allTasks = [task, candidate];
    storeState._tasksById = new Map([[task.id, task], [candidate.id, candidate]]);
    const onStatusChange = vi.fn(async () => ({ success: false, error: 'Maximum focus limit reached' }));

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={task}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            onTint: '#ffffff',
            inputBg: '#222222',
            filterBg: '#333333',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={onStatusChange}
          onDelete={vi.fn()}
        />
      );
    });

    const doneAction = tree.root.find((node) => node.props.accessibilityLabel === 'Done action' && typeof node.props.onPress === 'function');
    await renderer.act(async () => {
      doneAction.props.onPress();
      await Promise.resolve();
    });

    expect(hasText(tree, "What's the next action?")).toBe(false);
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Maximum focus limit reached',
      tone: 'error',
    }));
  });

  it('reports a failed completion undo', async () => {
    undoTaskCompletion.mockRejectedValueOnce(new Error('Could not restore status'));
    const task = {
      id: 'task-undo',
      title: 'Finish current step',
      status: 'next',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as any;

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={task}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn().mockResolvedValue({ success: true })}
          onDelete={vi.fn()}
        />
      );
    });

    const doneAction = tree.root.find(
      (node) => node.props.accessibilityLabel === 'Done action' && typeof node.props.onPress === 'function'
    );
    await renderer.act(async () => {
      doneAction.props.onPress();
      await Promise.resolve();
    });

    const undoToast = showToast.mock.calls
      .map(([options]) => options)
      .find((options) => options?.actionLabel === 'Undo');
    expect(undoToast).toBeDefined();

    await renderer.act(async () => {
      undoToast.onAction();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Could not restore status',
      tone: 'error',
    }));
  });

  it('keeps the next-action prompt open when promoting a candidate fails', async () => {
    const project = { id: 'project-1', title: 'Launch plan', status: 'active' };
    const task = {
      id: 'task-1',
      title: 'Finish current step',
      status: 'next',
      projectId: 'project-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as any;
    const candidate = {
      id: 'task-2',
      title: 'Draft follow-up',
      status: 'someday',
      projectId: 'project-1',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    } as any;
    storeState.projects = [project];
    storeState._allProjects = [project];
    storeState._allTasks = [task, candidate];
    storeState._tasksById = new Map([[task.id, task], [candidate.id, candidate]]);
    updateTask.mockResolvedValueOnce({ success: false, error: 'Project is locked' });
    const onStatusChange = vi.fn((status: string) => {
      const updatedTask = { ...task, status };
      storeState._allTasks = [updatedTask, candidate];
      storeState._tasksById = new Map([[updatedTask.id, updatedTask], [candidate.id, candidate]]);
      return Promise.resolve({ success: true });
    });

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={task}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            onTint: '#ffffff',
            inputBg: '#222222',
            filterBg: '#333333',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={onStatusChange}
          onDelete={vi.fn()}
        />
      );
    });

    const doneAction = tree.root.find((node) => node.props.accessibilityLabel === 'Done action' && typeof node.props.onPress === 'function');
    await renderer.act(async () => {
      doneAction.props.onPress();
      await Promise.resolve();
    });

    const candidateAction = tree.root.find((node) => node.props.accessibilityLabel === 'Draft follow-up' && typeof node.props.onPress === 'function');
    await renderer.act(async () => {
      candidateAction.props.onPress();
      await Promise.resolve();
    });

    expect(hasText(tree, "What's the next action?")).toBe(true);
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Project is locked',
      tone: 'error',
    }));
  });

  it('can add a new project next action from the completion prompt', async () => {
    const project = { id: 'project-1', title: 'Launch plan', status: 'active' };
    const task = {
      id: 'task-1',
      title: 'Finish current step',
      status: 'next',
      projectId: 'project-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as any;
    storeState.projects = [project];
    storeState._allProjects = [project];
    storeState._allTasks = [task];
    storeState._tasksById = new Map([[task.id, task]]);
    const onStatusChange = vi.fn((status: string) => {
      const updatedTask = { ...task, status };
      storeState._allTasks = [updatedTask];
      storeState._tasksById = new Map([[updatedTask.id, updatedTask]]);
    });

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={task}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            onTint: '#ffffff',
            inputBg: '#222222',
            filterBg: '#333333',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={onStatusChange}
          onDelete={vi.fn()}
        />
      );
    });

    const doneAction = tree.root.find((node) => node.props.accessibilityLabel === 'Done action' && typeof node.props.onPress === 'function');
    await renderer.act(async () => {
      doneAction.props.onPress();
      await Promise.resolve();
    });

    const input = tree.root.find((node) => node.props.accessibilityLabel === 'Add a new next action');
    renderer.act(() => {
      input.props.onChangeText('Call Alex');
    });

    const addButton = tree.root.find((node) => node.props.accessibilityLabel === 'Add next action' && typeof node.props.onPress === 'function');
    await renderer.act(async () => {
      addButton.props.onPress();
      await Promise.resolve();
    });

    expect(addTask).toHaveBeenCalledWith('Call Alex', {
      status: 'next',
      projectId: 'project-1',
      sectionId: undefined,
    });
  });

  it('cancels pending checklist flushes when deleting a task', () => {
    vi.useFakeTimers();
    const alertSpy = vi.spyOn(Alert, 'alert');
    const onDelete = vi.fn();
    const task = {
      id: 'task-1',
      title: 'Pay rent',
      status: 'inbox',
      checklist: [{ id: 'item-1', title: 'Confirm amount', isCompleted: false }],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as any;
    storeState.tasks = [task];
    getChecklistProgress.mockImplementation((value: any) => {
      const checklist = value?.checklist ?? [];
      if (!checklist.length) return null;
      const completed = checklist.filter((entry: any) => entry.isCompleted).length;
      return {
        completed,
        total: checklist.length,
        percent: completed / checklist.length,
      };
    });

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={task}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={onDelete}
        />
      );
    });

    const checklistProgressButton = tree.root.find((node) => node.props.accessibilityLabel === 'checklist.progress');
    renderer.act(() => {
      checklistProgressButton.props.onPress();
    });

    const checklistItemButton = tree.root.find(
      (node) => node.props.accessibilityLabel === 'Confirm amount' && typeof node.props.onPress === 'function'
    );
    renderer.act(() => {
      checklistItemButton.props.onPress();
    });

    expect(updateTask).not.toHaveBeenCalled();

    const deleteAction = tree.root.find(
      (node) => node.props.accessibilityLabel === 'Delete task' && typeof node.props.onPress === 'function'
    );
    renderer.act(() => {
      deleteAction.props.onPress();
    });

    renderer.act(() => {
      tree.unmount();
      vi.runAllTimers();
    });

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(updateTask).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('disables nested mutation controls when the task row is read-only', () => {
    const task = {
      id: 'task-1',
      title: 'Archived release notes',
      status: 'done',
      isFocusedToday: true,
      completedAt: '2026-05-12T08:30:00.000Z',
      checklist: [{ id: 'item-1', title: 'Confirm archive', isCompleted: false }],
      createdAt: '2026-05-01T08:30:00.000Z',
      updatedAt: '2026-05-12T08:30:00.000Z',
    } as any;
    storeState._allTasks = [task];
    getChecklistProgress.mockReturnValue({ completed: 0, total: 1, percent: 0 });
    const onPress = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={task}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={onPress}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
          interactionDisabled
          allowInspectionWhenDisabled
          showFocusToggle
        />
      );
    });

    const checklistProgressButton = tree.root.find(
      (node) => node.props.accessibilityLabel === 'checklist.progress'
    );
    renderer.act(() => {
      checklistProgressButton.props.onPress();
    });

    const checklistItemButton = tree.root.find(
      (node) => node.props.accessibilityLabel === 'Confirm archive'
    );
    const statusButton = tree.root.find(
      (node) => node.props.accessibilityLabel === 'Change status. Current status: Done'
    );

    expect(checklistItemButton.props.disabled).toBe(true);
    expect(checklistItemButton.props.onPress).toBeUndefined();
    expect(checklistItemButton.props.accessibilityState).toEqual({ checked: false, disabled: true });
    expect(statusButton.props.disabled).toBe(true);
    expect(statusButton.props.onPress).toBeUndefined();
    expect(statusButton.props.accessibilityState).toEqual({ disabled: true });
    expect(() => tree.root.find((node) => node.props.accessibilityLabel === 'Edit completion time')).toThrow();
    expect(() => tree.root.find((node) => node.props.accessibilityLabel === 'Remove from focus')).toThrow();
    expect(() => tree.root.findByType('CompletedAtPicker' as any)).toThrow();
    expect(updateTask).not.toHaveBeenCalled();

    const inspectionButton = tree.root.find((node) => (
      typeof node.props.accessibilityLabel === 'string'
      && node.props.accessibilityLabel.startsWith('Archived release notes')
      && Array.isArray(node.props.accessibilityActions)
    ));
    expect(inspectionButton.props.disabled).not.toBe(true);
    expect(inspectionButton.props.accessibilityActions).toEqual([{ name: 'activate', label: 'View' }]);
    renderer.act(() => inspectionButton.props.onPress());
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending checklist write when a task row becomes read-only', () => {
    vi.useFakeTimers();
    const task = {
      id: 'task-1',
      title: 'Archive in progress',
      status: 'next',
      checklist: [{ id: 'item-1', title: 'Stop pending write', isCompleted: false }],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as any;
    storeState._allTasks = [task];
    getChecklistProgress.mockReturnValue({ completed: 0, total: 1, percent: 0 });
    const onPress = vi.fn();
    const onStatusChange = vi.fn();
    const onDelete = vi.fn();
    const renderRow = (interactionDisabled: boolean) => (
      <SwipeableTaskItem
        task={task}
        isDark={false}
        tc={{
          taskItemBg: '#111111',
          border: '#222222',
          text: '#ffffff',
          secondaryText: '#999999',
          tint: '#3b82f6',
          warning: '#f59e0b',
        } as any}
        onPress={onPress}
        onStatusChange={onStatusChange}
        onDelete={onDelete}
        interactionDisabled={interactionDisabled}
      />
    );

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(renderRow(false));
    });
    renderer.act(() => {
      tree.root.find((node) => node.props.accessibilityLabel === 'checklist.progress').props.onPress();
    });
    renderer.act(() => {
      tree.root.find((node) => (
        node.props.accessibilityLabel === 'Stop pending write'
        && typeof node.props.onPress === 'function'
      )).props.onPress();
    });

    expect(updateTask).not.toHaveBeenCalled();
    renderer.act(() => {
      tree.update(renderRow(true));
    });
    renderer.act(() => {
      vi.runAllTimers();
      tree.unmount();
    });

    expect(updateTask).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('hides checklist progress when requested by the list view', () => {
    const task = {
      id: 'task-1',
      title: 'Plan move',
      status: 'inbox',
      checklist: [{ id: 'item-1', title: 'Book van', isCompleted: false }],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as any;
    getChecklistProgress.mockReturnValue({
      completed: 0,
      total: 1,
      percent: 0,
    });

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={task}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
          hideChecklistProgress
        />
      );
    });

    expect(() => tree.root.find((node) => node.props.accessibilityLabel === 'checklist.progress')).toThrow();
  });

  it('keeps reference checklists non-actionable in task rows', () => {
    const task = {
      id: 'task-1',
      title: 'Reference checklist',
      status: 'reference',
      checklist: [{ id: 'item-1', title: 'Book van', isCompleted: false }],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as any;
    getChecklistProgress.mockReturnValue({
      completed: 0,
      total: 1,
      percent: 0,
    });

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={task}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
        />
      );
    });

    expect(() => tree.root.find((node) => node.props.accessibilityLabel === 'checklist.progress')).toThrow();
    expect(() => tree.root.find((node) => node.props.accessibilityLabel === 'Book van')).toThrow();
  });

  it('flushes checklist updates using the full task set, not only visible tasks', () => {
    vi.useFakeTimers();
    const task = {
      id: 'task-1',
      title: 'Pack samples',
      status: 'next',
      taskMode: 'list',
      checklist: [{ id: 'item-1', title: 'Seal box', isCompleted: false }],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as any;
    storeState.tasks = [];
    storeState._allTasks = [task];
    getChecklistProgress.mockImplementation((value: any) => {
      const checklist = value?.checklist ?? [];
      if (!checklist.length) return null;
      const completed = checklist.filter((entry: any) => entry.isCompleted).length;
      return {
        completed,
        total: checklist.length,
        percent: completed / checklist.length,
      };
    });

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={task}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
        />
      );
    });

    const checklistProgressButton = tree.root.find((node) => node.props.accessibilityLabel === 'checklist.progress');
    renderer.act(() => {
      checklistProgressButton.props.onPress();
    });

    const checklistItemButton = tree.root.find(
      (node) => node.props.accessibilityLabel === 'Seal box' && typeof node.props.onPress === 'function'
    );
    renderer.act(() => {
      checklistItemButton.props.onPress();
    });
    renderer.act(() => {
      tree.unmount();
    });

    expect(updateTask).toHaveBeenCalledWith('task-1', {
      checklist: [{ id: 'item-1', title: 'Seal box', isCompleted: true }],
      status: 'done',
    });
    vi.useRealTimers();
  });

  // #1055: the inline expansion can add items, not just tick them. The add goes
  // through the same pending/flush pipeline as a tick, so the list-mode status
  // recomputation (done -> next once an unchecked item exists) comes along free.
  it('adds a checklist item from the row expansion and flushes it with the recomputed status', () => {
    vi.useFakeTimers();
    translate.overrides = { 'taskEdit.addItem': 'Add Item' };
    const task = {
      id: 'task-1',
      title: 'Groceries',
      status: 'done',
      taskMode: 'list',
      checklist: [{ id: 'item-1', title: 'Bread', isCompleted: true }],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as any;
    storeState.tasks = [task];
    storeState._allTasks = [task];
    getChecklistProgress.mockImplementation((value: any) => {
      const checklist = value?.checklist ?? [];
      if (!checklist.length) return null;
      const completed = checklist.filter((entry: any) => entry.isCompleted).length;
      return {
        completed,
        total: checklist.length,
        percent: completed / checklist.length,
      };
    });

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={task}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
        />
      );
    });

    const findAddInputs = () => tree.root.findAll((node) => (
      typeof node.type === 'string'
      && node.props.accessibilityLabel === 'Add Item'
      && typeof node.props.onSubmitEditing === 'function'
    ));

    // Collapsed rows show no add field, and opening the expansion must not steal focus.
    expect(findAddInputs()).toHaveLength(0);
    const checklistProgressButton = tree.root.find((node) => node.props.accessibilityLabel === 'checklist.progress');
    renderer.act(() => {
      checklistProgressButton.props.onPress();
    });
    expect(findAddInputs()[0].props.autoFocus).toBeFalsy();

    renderer.act(() => {
      findAddInputs()[0].props.onChangeText('Milk');
    });
    renderer.act(() => {
      findAddInputs()[0].props.onSubmitEditing();
    });

    // Field cleared for the next item, keyboard kept up.
    expect(findAddInputs()[0].props.value).toBe('');
    expect(findAddInputs()[0].props.blurOnSubmit).toBe(false);

    renderer.act(() => {
      vi.runAllTimers();
    });

    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledWith('task-1', {
      checklist: [
        { id: 'item-1', title: 'Bread', isCompleted: true },
        expect.objectContaining({ title: 'Milk', isCompleted: false }),
      ],
      status: 'next',
    });
    expect(updateTask.mock.calls[0][1].checklist[1].id).toBeTruthy();

    renderer.act(() => {
      tree.unmount();
    });
    vi.useRealTimers();
  });

  it('ignores a whitespace-only checklist add and never flushes half-typed text', () => {
    vi.useFakeTimers();
    translate.overrides = { 'taskEdit.addItem': 'Add Item' };
    const task = {
      id: 'task-1',
      title: 'Groceries',
      status: 'next',
      checklist: [{ id: 'item-1', title: 'Bread', isCompleted: false }],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as any;
    storeState.tasks = [task];
    storeState._allTasks = [task];
    getChecklistProgress.mockReturnValue({ completed: 0, total: 1, percent: 0 });

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <SwipeableTaskItem
          task={task}
          isDark={false}
          tc={{
            taskItemBg: '#111111',
            border: '#222222',
            text: '#ffffff',
            secondaryText: '#999999',
            tint: '#3b82f6',
            warning: '#f59e0b',
          } as any}
          onPress={vi.fn()}
          onStatusChange={vi.fn()}
          onDelete={vi.fn()}
        />
      );
    });

    const findAddInputs = () => tree.root.findAll((node) => (
      typeof node.type === 'string'
      && node.props.accessibilityLabel === 'Add Item'
      && typeof node.props.onSubmitEditing === 'function'
    ));

    const checklistProgressButton = tree.root.find((node) => node.props.accessibilityLabel === 'checklist.progress');
    renderer.act(() => {
      checklistProgressButton.props.onPress();
    });
    renderer.act(() => {
      findAddInputs()[0].props.onChangeText('   ');
    });
    renderer.act(() => {
      findAddInputs()[0].props.onSubmitEditing();
    });
    renderer.act(() => {
      vi.runAllTimers();
    });

    expect(updateTask).not.toHaveBeenCalled();

    // Typed-but-unsubmitted text is draft state only: it must not reach the unmount flush.
    renderer.act(() => {
      findAddInputs()[0].props.onChangeText('Eggs');
    });
    renderer.act(() => {
      tree.unmount();
      vi.runAllTimers();
    });

    expect(updateTask).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  // The #766 boundary itself: a list re-render must not re-render rows whose
  // task did not change. Guarded with the real render counter. `tc` is one
  // shared object because that is what resolveThemeTokens now hands callers.
  it('re-renders only the row whose task changed', () => {
    const actions: TaskRowActions = {
      edit: vi.fn(),
      changeStatus: vi.fn(),
      remove: vi.fn(),
    };
    const themeColors = {
      taskItemBg: '#111111',
      border: '#222222',
      text: '#ffffff',
      secondaryText: '#999999',
      tint: '#3b82f6',
      warning: '#f59e0b',
    } as any;
    const taskA = {
      id: 'task-a',
      title: 'Task A',
      status: 'next',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as any;
    const taskB = { ...taskA, id: 'task-b', title: 'Task B' };

    const List = ({ tasks }: { tasks: any[] }) => (
      <>
        {tasks.map((task) => (
          <SwipeableTaskItem
            key={task.id}
            task={task}
            isDark={false}
            tc={themeColors}
            actions={actions}
            statusBadgeAsIcon
          />
        ))}
      </>
    );

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<List tasks={[taskA, taskB]} />);
    });
    const afterMount = readTaskRowRenderCount();
    expect(afterMount).toBeGreaterThanOrEqual(2);

    const renamedA = { ...taskA, title: 'Task A renamed' };
    renderer.act(() => {
      tree.update(<List tasks={[renamedA, taskB]} />);
    });

    // Exactly one: the renamed row re-rendered, the untouched one did not.
    expect(readTaskRowRenderCount() - afterMount).toBe(1);
    expect(hasText(tree, 'Task A renamed')).toBe(true);
  });

  describe('priority strip', () => {
    const renderRow = (task: Record<string, unknown>) => {
      let tree!: renderer.ReactTestRenderer;
      renderer.act(() => {
        tree = renderer.create(
          <SwipeableTaskItem
            task={{
              id: 'task-1',
              title: 'Do laundry',
              status: 'inbox',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              ...task,
            } as any}
            isDark={false}
            tc={{
              taskItemBg: '#111111',
              border: '#222222',
              text: '#ffffff',
              secondaryText: '#999999',
              tint: '#3b82f6',
              warning: '#f59e0b',
            } as any}
            onPress={vi.fn()}
            onStatusChange={vi.fn()}
            onDelete={vi.fn()}
          />
        );
      });
      const strips = tree.root.findAll((node) => node.props?.testID === 'task-priority-strip');
      return strips.length === 0 ? null : flattenStyle(strips[0].props.style);
    };

    const rowAccessibilityLabel = (task: Record<string, unknown>) => {
      let tree!: renderer.ReactTestRenderer;
      renderer.act(() => {
        tree = renderer.create(
          <SwipeableTaskItem
            task={{
              id: 'task-1',
              title: 'Do laundry',
              status: 'inbox',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              ...task,
            } as any}
            isDark={false}
            tc={{ taskItemBg: '#111111', border: '#222222', text: '#ffffff', secondaryText: '#999999', tint: '#3b82f6', warning: '#f59e0b' } as any}
            onPress={vi.fn()}
            onStatusChange={vi.fn()}
            onDelete={vi.fn()}
          />
        );
      });
      const rows = tree.root.findAll((node) => (
        typeof node.props?.accessibilityLabel === 'string'
        && node.props.accessibilityLabel.includes('Do laundry')
      ));
      return rows[0]?.props.accessibilityLabel as string;
    };

    it('paints one strip per priority', () => {
      expect(renderRow({ priority: 'urgent' })).toEqual(expect.objectContaining({
        backgroundColor: '#dc2626',
        position: 'absolute',
        width: 3,
      }));
      expect(renderRow({ priority: 'high' })?.backgroundColor).toBe('#f97316');
      expect(renderRow({ priority: 'medium' })?.backgroundColor).toBe('#ca8a04');
      expect(renderRow({ priority: 'low' })?.backgroundColor).toBe('#3b82f6');
    });

    it('sits on the leading edge so it follows RTL', () => {
      expect(renderRow({ priority: 'low' })?.insetInlineStart).toBe(6);
    });

    it('renders no strip when the priorities feature is off or the task has none', () => {
      expect(renderRow({})).toBeNull();
      storeState.settings = { features: { priorities: false }, appearance: {} } as any;
      expect(renderRow({ priority: 'urgent' })).toBeNull();
    });

    // No green, no special case: a done row keeps its priority color and only
    // the row's own completed styling changes.
    it('keeps the priority color on a completed task', () => {
      expect(renderRow({ status: 'done', priority: 'low' })?.backgroundColor).toBe('#3b82f6');
    });

    // The strip is the row's only priority signal here, so the level must not
    // be color-only: it rides the row's accessibility label.
    it('names the priority in the row accessibility label, and only when the strip shows', () => {
      expect(rowAccessibilityLabel({ priority: 'high' })).toContain('Priority: High');
      expect(rowAccessibilityLabel({})).not.toContain('Priority');
      storeState.settings = { features: { priorities: false }, appearance: {} } as any;
      expect(rowAccessibilityLabel({ priority: 'high' })).not.toContain('Priority');
    });
  });
});
