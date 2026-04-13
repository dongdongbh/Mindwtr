import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import renderer from 'react-test-renderer';
import { Alert } from 'react-native';

import { SwipeableTaskItem } from './swipeable-task-item';

const { updateTask, getChecklistProgress, storeState } = vi.hoisted(() => ({
  updateTask: vi.fn(),
  getChecklistProgress: vi.fn((_value: any): any => null),
  storeState: {
    updateTask: vi.fn(),
    projects: [] as any[],
    areas: [] as any[],
    settings: { features: {} },
    getDerivedState: () => ({ focusedCount: 0 }),
    tasks: [] as any[],
  },
}));
const hapticsMocks = vi.hoisted(() => ({
  notificationAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@mindwtr/core', () => {
  storeState.updateTask = updateTask;
  const useTaskStore = Object.assign(
    (selector?: (state: typeof storeState) => unknown) =>
      selector ? selector(storeState) : storeState,
    {
      getState: () => storeState,
    }
  );

  return {
    useTaskStore,
    shallow: (value: unknown) => value,
    getChecklistProgress,
    getTaskAgeLabel: () => '',
    getTaskStaleness: () => 'fresh',
    getStatusColor: () => ({ bg: '#111111', border: '#222222', text: '#333333' }),
    hasTimeComponent: () => false,
    safeFormatDate: () => '',
    safeParseDueDate: () => null,
    resolveTaskTextDirection: () => 'ltr',
  };
});

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({
    language: 'en',
    t: (key: string) =>
      ({
        'common.cancel': 'Cancel',
        'common.delete': 'Delete',
        'common.edit': 'Edit',
        'status.inbox': 'Inbox',
        'status.next': 'Next',
        'task.aria.delete': 'Delete task',
        'task.deleteConfirmBody': 'Move this task to Trash?',
      }[key] ?? key),
  }),
}));

vi.mock('react-native-gesture-handler', () => ({
  Swipeable: ({ renderLeftActions, renderRightActions, children }: any) =>
    React.createElement(
      'Swipeable',
      {},
      renderLeftActions ? renderLeftActions() : null,
      renderRightActions ? renderRightActions() : null,
      children
    ),
}));

vi.mock('expo-haptics', () => ({
  NotificationFeedbackType: {
    Success: 'success',
    Warning: 'warning',
  },
  notificationAsync: hapticsMocks.notificationAsync,
}));

vi.mock('../contexts/toast-context', () => ({
  useToast: () => ({
    showToast: vi.fn(),
    dismissToast: vi.fn(),
  }),
}));

vi.mock('lucide-react-native', () => ({
  ArrowRight: (props: any) => React.createElement('ArrowRight', props),
  Check: (props: any) => React.createElement('Check', props),
  RotateCcw: (props: any) => React.createElement('RotateCcw', props),
  Trash2: (props: any) => React.createElement('Trash2', props),
}));

describe('SwipeableTaskItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState.projects = [];
    storeState.tasks = [];
    getChecklistProgress.mockReturnValue(null);
  });

  it('confirms deletion before invoking onDelete', () => {
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

    expect(alertSpy).toHaveBeenCalledWith(
      'Pay rent',
      'Move this task to Trash?',
      expect.arrayContaining([
        expect.objectContaining({ text: 'Cancel', style: 'cancel' }),
        expect.objectContaining({ text: 'Delete', style: 'destructive', onPress: expect.any(Function) }),
      ]),
      { cancelable: true }
    );
    expect(onDelete).not.toHaveBeenCalled();

    const alertButtons = alertSpy.mock.calls[0]?.[2] as { text?: string; onPress?: () => void }[];
    const destructiveAction = alertButtons.find((button) => button.text === 'Delete');
    expect(destructiveAction?.onPress).toBeTypeOf('function');

    renderer.act(() => {
      destructiveAction?.onPress?.();
    });

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(hapticsMocks.notificationAsync).toHaveBeenCalledWith('warning');
  });

  it('navigates from project, context, and tag meta labels', () => {
    const onProjectPress = vi.fn();
    const onContextPress = vi.fn();
    const onTagPress = vi.fn();
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
            status: 'inbox',
            projectId: 'project-1',
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

    const projectButton = tree.root.find((node) => node.props.accessibilityLabel === 'Open project Mindwtr');
    const contextButton = tree.root.find((node) => node.props.accessibilityLabel === 'Open context @work');
    const tagButton = tree.root.find((node) => node.props.accessibilityLabel === 'Open tag #urgent');

    renderer.act(() => {
      projectButton.props.onPress({ stopPropagation: vi.fn() });
      contextButton.props.onPress({ stopPropagation: vi.fn() });
      tagButton.props.onPress({ stopPropagation: vi.fn() });
    });

    expect(onProjectPress).toHaveBeenCalledWith('project-1');
    expect(onContextPress).toHaveBeenCalledWith('@work');
    expect(onTagPress).toHaveBeenCalledWith('#urgent');
  });

  it('announces swipe directions and triggers haptics for status actions', () => {
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

    expect(taskButton.props.accessibilityHint).toContain('Swipe right to next');
    expect(taskButton.props.accessibilityHint).toContain('swipe left to delete');

    renderer.act(() => {
      nextAction.props.onPress();
    });

    expect(onStatusChange).toHaveBeenCalledWith('next');
    expect(hapticsMocks.notificationAsync).toHaveBeenCalledWith('success');
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

    const alertButtons = alertSpy.mock.calls[0]?.[2] as { text?: string; onPress?: () => void }[];
    const destructiveAction = alertButtons.find((button) => button.text === 'Delete');
    renderer.act(() => {
      destructiveAction?.onPress?.();
      tree.unmount();
      vi.runAllTimers();
    });

    expect(onDelete).toHaveBeenCalledTimes(1);
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
});
