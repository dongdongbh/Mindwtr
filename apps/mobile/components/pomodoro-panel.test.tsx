import React from 'react';
import { FlatList, Pressable, Text } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Task } from '@mindwtr/core';

import { PomodoroPanel } from './pomodoro-panel';
import { mobilePomodoroController } from '../lib/pomodoro-controller';

const { storeState, storeListeners } = vi.hoisted(() => ({
  storeListeners: new Set<() => void>(),
  storeState: {
    tasks: [] as any[],
    updateTask: vi.fn(),
    settings: {
      notificationsEnabled: false,
      gtd: {
        pomodoro: {},
      },
    },
  },
}));

vi.mock('@mindwtr/core', async () => {
  const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
  const { useSyncExternalStore } = await vi.importActual<typeof import('react')>('react');
  const useTaskStore = Object.assign((selector?: (state: typeof storeState) => unknown) => useSyncExternalStore(
    (listener) => { storeListeners.add(listener); return () => { storeListeners.delete(listener); }; },
    () => selector ? selector(storeState) : storeState,
  ), {
    getState: () => storeState,
  });

  return {
    ...actual,
    useTaskStore,
  };
});

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
  },
}));

vi.mock('../contexts/language-context', () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    bg: '#000000',
    cardBg: '#111827',
    inputBg: '#111827',
    filterBg: '#1f2937',
    border: '#334155',
    text: '#f8fafc',
    secondaryText: '#94a3b8',
    icon: '#94a3b8',
    tint: '#3b82f6',
    onTint: '#ffffff',
    danger: '#ef4444',
    success: '#10b981',
    warning: '#f59e0b',
  }),
}));

vi.mock('@/hooks/use-filled-button-colors', () => ({
  useFilledButtonColors: () => ({
    backgroundColor: '#3b82f6',
    textColor: '#ffffff',
  }),
}));

vi.mock('../lib/notification-service', () => ({
  cancelMobilePomodoroCompletionNotification: vi.fn(async () => undefined),
  scheduleMobilePomodoroCompletionNotification: vi.fn(async () => undefined),
}));

vi.mock('../lib/app-log', () => ({
  logWarn: vi.fn(async () => undefined),
  logInfo: vi.fn(async () => undefined),
}));

const flattenText = (value: unknown): string => {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map((item) => flattenText(item)).join('');
  if (value && typeof value === 'object') {
    const item = value as { children?: unknown; props?: { children?: unknown } };
    return flattenText(item.props?.children ?? item.children);
  }
  return '';
};

const flattenStyle = (style: unknown): Record<string, unknown> => {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.filter(Boolean).map(flattenStyle));
  }
  return style && typeof style === 'object' ? style as Record<string, unknown> : {};
};

const pressableText = (tree: renderer.ReactTestRenderer) => (
  tree.root.findAllByType(Pressable).map((node) => flattenText(node.props.children))
);

const renderPanel = async () => {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<PomodoroPanel tasks={[]} onMarkDone={vi.fn()} />);
  });
  return tree;
};

describe('PomodoroPanel', () => {
  beforeEach(() => {
    mobilePomodoroController.resetForTests();
    storeState.settings = {
      notificationsEnabled: false,
      gtd: {
        pomodoro: {},
      },
    };
    storeState.tasks = [];
    storeState.updateTask.mockResolvedValue({ success: true });
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(null);
    vi.mocked(AsyncStorage.setItem).mockResolvedValue(undefined);
    vi.mocked(AsyncStorage.setItem).mockClear();
  });

  it('keeps restored local session history when persisting the timer state', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValueOnce(JSON.stringify({
      durations: { focusMinutes: 25, breakMinutes: 5 },
      timerState: {
        phase: 'focus',
        remainingSeconds: 1500,
        isRunning: false,
        completedFocusSessions: 0,
      },
      selectedTaskId: 'task-1',
      sessionHistory: {
        totalCompletedFocusSessions: 4,
        completedFocusSessionsByTaskId: {
          'task-1': 2,
        },
      },
    }));

    await renderPanel();
    await act(async () => undefined);

    const lastWrite = vi.mocked(AsyncStorage.setItem).mock.calls.at(-1);
    expect(lastWrite?.[0]).toBe('@mindwtr_pomodoro_state');
    expect(JSON.parse(String(lastWrite?.[1]))).toMatchObject({
      timerState: expect.objectContaining({ completedFocusSessions: 4 }),
      selectedTaskId: 'task-1',
      sessionHistory: {
        totalCompletedFocusSessions: 4,
        completedFocusSessionsByTaskId: {
          'task-1': 2,
        },
      },
    });
  });

  it('renders the phase as read-only status and names the next switch action', async () => {
    const tree = await renderPanel();

    const textValues = tree.root.findAllByType(Text).map((node) => flattenText(node.props.children));
    expect(textValues).toContain('Pomodoro Timer');
    expect(textValues).not.toContain('Pomodoro Focus');
    expect(pressableText(tree)).toContain('Switch to Break');
    expect(pressableText(tree)).not.toContain('Switch');

    const phaseText = tree.root.findAllByType(Text)
      .find((node) => flattenText(node.props.children) === 'Focus');
    expect(phaseText).toBeDefined();
    expect(phaseText?.parent?.type).toBe('View');
    expect(flattenStyle(phaseText?.parent?.props.style).borderWidth ?? 0).toBe(0);

    const switchButton = tree.root.findAllByType(Pressable)
      .find((node) => flattenText(node.props.children) === 'Switch to Break');
    expect(switchButton).toBeDefined();
    act(() => {
      switchButton?.props.onPress();
    });

    expect(pressableText(tree)).toContain('Switch to Focus');
    expect(tree.root.findAllByType(Text).some((node) => flattenText(node.props.children) === 'Break')).toBe(true);
  });

  // The shared getItem mock is key-blind, and the panel now reads two keys.
  // Keying the implementation keeps the collapse read from consuming a value
  // queued for the session read (or vice versa).
  const mockStorage = (values: Record<string, string | null>) => {
    vi.mocked(AsyncStorage.getItem).mockImplementation(async (key: string) => values[key] ?? null);
  };

  const linkedTask: Task = {
    id: 'task-1', title: 'Current task', status: 'next', tags: [], contexts: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };

  const renderLinkedPanel = async (onMarkDone = vi.fn()) => {
    storeState.settings = { notificationsEnabled: false, gtd: { pomodoro: { linkTask: true } } };
    storeState.tasks = [linkedTask];
    mockStorage({ '@mindwtr_pomodoro_state': JSON.stringify({
      durations: { focusMinutes: 25, breakMinutes: 5 },
      timerState: { phase: 'focus', remainingSeconds: 1500, isRunning: false, completedFocusSessions: 4 },
      selectedTaskId: linkedTask.id,
      sessionHistory: { totalCompletedFocusSessions: 4, completedFocusSessionsByTaskId: { [linkedTask.id]: 2 } },
    }) });
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<PomodoroPanel tasks={[linkedTask]} onMarkDone={onMarkDone} />);
    });
    return tree;
  };

  const updateLiveTasks = (tasks: Task[]) => {
    storeState.tasks = tasks;
    storeListeners.forEach((listener) => listener());
  };

  it.each(['done', 'archived', 'cancelled', 'reference', 'deleted'] as const)(
    'unlinks a task becoming %s while the picker is open and preserves the timer', async (transition) => {
      const tree = await renderLinkedPanel();
      act(() => { mobilePomodoroController.toggle({}); });
      const picker = tree.root.findAllByType(Pressable)
        .find((node) => node.props.accessibilityLabel === 'Timer task');
      act(() => picker?.props.onPress());
      expect(tree.root.findByType(FlatList).props.data).toEqual([linkedTask]);
      const before = mobilePomodoroController.getSnapshot();

      act(() => updateLiveTasks(transition === 'deleted' ? [] : [{
        ...linkedTask,
        status: transition === 'cancelled' ? 'archived' : transition,
        ...(transition === 'cancelled' ? { cancelledAt: linkedTask.updatedAt } : {}),
      }]));

      expect(tree.root.findByType(FlatList).props.data).toEqual([]);
      expect(tree.root.findAllByType(Text).some((node) => flattenText(node.props.children) === linkedTask.title)).toBe(false);
      expect(tree.root.findAllByType(Pressable).some((node) => node.props.accessibilityLabel === 'Mark task done')).toBe(false);
      const after = mobilePomodoroController.getSnapshot();
      expect(after.selectedTaskId).toBeUndefined();
      expect(after.timerState).toEqual(before.timerState);
      expect(after.phaseEndsAt).toBe(before.phaseEndsAt);
      expect(after.sessionHistory).toEqual(before.sessionHistory);
      act(() => tree.unmount());
    }
  );

  it('resolves open picker titles from the live store', async () => {
    const tree = await renderLinkedPanel();
    const picker = tree.root.findAllByType(Pressable)
      .find((node) => node.props.accessibilityLabel === 'Timer task');
    act(() => picker?.props.onPress());
    const renamed = { ...linkedTask, title: 'Renamed live task' };

    act(() => updateLiveTasks([renamed]));

    expect(tree.root.findByType(FlatList).props.data).toEqual([renamed]);
    expect(mobilePomodoroController.getSnapshot().selectedTaskId).toBe(linkedTask.id);
    act(() => tree.unmount());
  });

  it('preserves the link until Mark done changes live state and forwards auto-start options', async () => {
    const onMarkDone = vi.fn();
    const tree = await renderLinkedPanel(onMarkDone);
    const clearEvent = vi.spyOn(mobilePomodoroController, 'clearLastEvent');
    const selectTask = vi.spyOn(mobilePomodoroController, 'setSelectedTaskId');
    try {
      act(() => {
        storeState.settings.gtd.pomodoro = { linkTask: true, autoStartBreaks: true, autoStartFocus: true };
        storeListeners.forEach((listener) => listener());
      });
      const markDone = tree.root.findAllByType(Pressable)
        .find((node) => node.props.accessibilityLabel === 'Mark task done');
      act(() => markDone?.props.onPress());
      expect(onMarkDone).toHaveBeenCalledWith(linkedTask.id);
      expect(clearEvent).toHaveBeenCalledWith({ autoStartBreaks: true, autoStartFocus: true });
      // The parent owns write errors; a pending or rejected write leaves live state untouched.
      expect(mobilePomodoroController.getSnapshot().selectedTaskId).toBe(linkedTask.id);
      act(() => updateLiveTasks([{ ...linkedTask, status: 'done' }]));
      expect(mobilePomodoroController.getSnapshot().selectedTaskId).toBeUndefined();
      expect(selectTask).toHaveBeenCalledWith(undefined, { autoStartBreaks: true, autoStartFocus: true });
    } finally {
      act(() => tree.unmount());
      clearEvent.mockRestore();
      selectTask.mockRestore();
    }
  });

  it('starts expanded so an update never hides a timer someone was using (#946)', async () => {
    mockStorage({});

    const tree = await renderPanel();

    expect(pressableText(tree)).toContain('Switch to Break');
  });

  it('folds down to the clock and phase when collapsed, keeping the timer readable (#946)', async () => {
    mockStorage({ '@mindwtr_pomodoro_collapsed': 'true' });

    const tree = await renderPanel();
    const textValues = tree.root.findAllByType(Text).map((node) => flattenText(node.props.children));

    // The clock and the phase survive the fold; the controls do not.
    expect(textValues).toContain('25:00');
    expect(textValues).toContain('Focus · Paused');
    expect(pressableText(tree)).not.toContain('Switch to Break');
  });

  it('keeps an out-of-scope live task linked while the picker stays scoped', async () => {
    const linkedTask = {
      id: 'linked-elsewhere',
      title: 'Review follow-up',
      status: 'waiting',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    storeState.settings = {
      notificationsEnabled: false,
      gtd: { pomodoro: { linkTask: true } },
    };
    storeState.tasks = [linkedTask];
    mockStorage({
      '@mindwtr_pomodoro_state': JSON.stringify({
        durations: { focusMinutes: 25, breakMinutes: 5 },
        timerState: {
          phase: 'focus',
          remainingSeconds: 1500,
          isRunning: false,
          completedFocusSessions: 0,
        },
        selectedTaskId: linkedTask.id,
      }),
    });

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<PomodoroPanel tasks={[]} onMarkDone={vi.fn()} />);
    });

    expect(tree.root.findAllByType(Text).map((node) => flattenText(node.props.children)))
      .toContain('Review follow-up');
    const picker = tree.root.findAllByType(Pressable)
      .find((node) => node.props.accessibilityLabel === 'Timer task');
    act(() => picker?.props.onPress());
    expect(tree.root.findByType(FlatList).props.data).toEqual([]);
    expect(tree.root.findAll((node) => node.props.accessibilityState?.selected === true))
      .toHaveLength(0);
  });

  it('announces whether a collapsed timer is running', async () => {
    const phaseEndsAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    mockStorage({
      '@mindwtr_pomodoro_collapsed': 'true',
      '@mindwtr_pomodoro_state': JSON.stringify({
        durations: { focusMinutes: 25, breakMinutes: 5 },
        timerState: {
          phase: 'focus',
          remainingSeconds: 600,
          isRunning: true,
          completedFocusSessions: 0,
        },
        phaseEndsAt,
      }),
    });

    const tree = await renderPanel();
    expect(tree.root.findAllByType(Text).map((node) => flattenText(node.props.children)))
      .toContain('Focus · Running');
  });

  it('persists the fold to this device only (#946)', async () => {
    mockStorage({});

    const tree = await renderPanel();
    const toggle = tree.root.findAllByType(Pressable)
      .find((node) => node.props.accessibilityLabel === 'Collapse timer');
    expect(toggle).toBeDefined();

    await act(async () => {
      toggle?.props.onPress();
    });

    expect(AsyncStorage.setItem).toHaveBeenCalledWith('@mindwtr_pomodoro_collapsed', 'true');
    // Collapsing is a presentation choice, not task data: it must never ride
    // along in the synced session payload.
    const sessionWrites = vi.mocked(AsyncStorage.setItem).mock.calls
      .filter(([key]) => key === '@mindwtr_pomodoro_state');
    sessionWrites.forEach(([, value]) => {
      expect(String(value)).not.toContain('collapsed');
    });
  });

  it.each([
    { autoStartBreaks: false, autoStartFocus: false },
    { autoStartBreaks: false, autoStartFocus: true },
    { autoStartBreaks: true, autoStartFocus: false },
    { autoStartBreaks: true, autoStartFocus: true },
  ])('forwards breaks=$autoStartBreaks focus=$autoStartFocus when picking or clearing a task', async (autoStartOptions) => {
    const task = { id: 'task-b', title: 'Read', status: 'next' } as Task;
    storeState.settings.gtd.pomodoro = { linkTask: true, ...autoStartOptions };
    storeState.tasks = [task];
    mockStorage({});
    const select = vi.spyOn(mobilePomodoroController, 'setSelectedTaskId');
    let tree!: renderer.ReactTestRenderer;
    try {
      await act(async () => {
        tree = renderer.create(<PomodoroPanel tasks={[task]} onMarkDone={vi.fn()} />);
      });
      act(() => tree.root.findAllByType(Pressable)
        .find((node) => node.props.accessibilityLabel === 'Timer task')?.props.onPress());
      const option = tree.root.findByType(FlatList).props.renderItem({ item: task });
      act(() => option.props.onPress());
      expect(select).toHaveBeenLastCalledWith(task.id, autoStartOptions);
      expect(mobilePomodoroController.getSnapshot().selectedTaskId).toBe(task.id);

      act(() => tree.root.findAllByType(Pressable)
        .find((node) => node.props.accessibilityLabel === 'Timer task')?.props.onPress());
      act(() => tree.root.findAllByType(Pressable)
        .find((node) => flattenText(node.props.children) === 'Timer only')?.props.onPress());
      expect(select).toHaveBeenLastCalledWith(undefined, autoStartOptions);
      expect(mobilePomodoroController.getSnapshot().selectedTaskId).toBeUndefined();
    } finally {
      if (tree) await act(async () => tree.unmount());
      select.mockRestore();
    }
  });

  it('forwards auto-start preferences when clearing a selection absent from the full live store', async () => {
    const autoStartOptions = { autoStartBreaks: true, autoStartFocus: true };
    storeState.settings.gtd.pomodoro = { linkTask: true, ...autoStartOptions };
    mockStorage({
      '@mindwtr_pomodoro_state': JSON.stringify({
        durations: { focusMinutes: 25, breakMinutes: 5 },
        timerState: { phase: 'focus', remainingSeconds: 1500, isRunning: false, completedFocusSessions: 0 },
        selectedTaskId: 'no-longer-live',
      }),
    });
    const select = vi.spyOn(mobilePomodoroController, 'setSelectedTaskId');
    const tree = await renderPanel();
    try {
      expect(select).toHaveBeenCalledExactlyOnceWith(undefined, autoStartOptions);
      expect(mobilePomodoroController.getSnapshot().selectedTaskId).toBeUndefined();
    } finally {
      await act(async () => tree.unmount());
      select.mockRestore();
    }
  });

  it('hides task linking without clearing the retained selection when linking is off', async () => {
    storeState.settings.gtd.pomodoro = { linkTask: false, autoStartBreaks: true, autoStartFocus: true };
    mockStorage({
      '@mindwtr_pomodoro_state': JSON.stringify({
        durations: { focusMinutes: 25, breakMinutes: 5 },
        timerState: { phase: 'focus', remainingSeconds: 1500, isRunning: false, completedFocusSessions: 0 },
        selectedTaskId: 'retained-outside-scope',
      }),
    });
    const select = vi.spyOn(mobilePomodoroController, 'setSelectedTaskId');
    const tree = await renderPanel();
    try {
      expect(select).not.toHaveBeenCalled();
      expect(mobilePomodoroController.getSnapshot().selectedTaskId).toBe('retained-outside-scope');
      expect(tree.root.findAllByType(FlatList)).toHaveLength(0);
      expect(tree.root.findAllByType(Pressable).some((node) => (
        ['Timer task', 'Mark task done'].includes(node.props.accessibilityLabel)
      ))).toBe(false);
    } finally {
      await act(async () => tree.unmount());
      select.mockRestore();
    }
  });
});
