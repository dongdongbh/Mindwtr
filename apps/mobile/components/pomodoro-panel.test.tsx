import React from 'react';
import { FlatList, Pressable, Text } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { PomodoroPanel } from './pomodoro-panel';

const { storeState } = vi.hoisted(() => ({
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
  const useTaskStore = Object.assign((selector?: (state: typeof storeState) => unknown) => (
    selector ? selector(storeState) : storeState
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

  it('never cancels the completion alarm before the stored session hydrates', async () => {
    const { cancelMobilePomodoroCompletionNotification, scheduleMobilePomodoroCompletionNotification } =
      await import('../lib/notification-service');
    vi.mocked(cancelMobilePomodoroCompletionNotification).mockClear();
    vi.mocked(scheduleMobilePomodoroCompletionNotification).mockClear();
    storeState.settings = { notificationsEnabled: true, gtd: { pomodoro: {} } };

    let releaseHydration!: (value: string) => void;
    vi.mocked(AsyncStorage.getItem).mockImplementationOnce(
      () => new Promise<string | null>((resolve) => {
        releaseHydration = resolve;
      })
    );

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<PomodoroPanel tasks={[]} onMarkDone={vi.fn()} />);
    });

    // A running timer's alarm must survive the pre-hydration render, where the
    // default state still reads as "not running" (#888).
    expect(cancelMobilePomodoroCompletionNotification).not.toHaveBeenCalled();

    const phaseEndsAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await act(async () => {
      releaseHydration(JSON.stringify({
        durations: { focusMinutes: 25, breakMinutes: 5 },
        timerState: {
          phase: 'focus',
          remainingSeconds: 600,
          isRunning: true,
          completedFocusSessions: 0,
        },
        phaseEndsAt,
        sessionHistory: {
          totalCompletedFocusSessions: 0,
          completedFocusSessionsByTaskId: {},
        },
      }));
    });

    expect(cancelMobilePomodoroCompletionNotification).not.toHaveBeenCalled();
    expect(scheduleMobilePomodoroCompletionNotification).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      new Date(phaseEndsAt),
      { phase: 'focus-complete' },
    );

    tree.unmount();
  });

  it('schedules the completion alarm while task reminders are off', async () => {
    // Task reminders are off on every fresh install, and the completion alert
    // used to be gated on them, so a timer the user started never alerted (#528).
    const { scheduleMobilePomodoroCompletionNotification } = await import('../lib/notification-service');
    vi.mocked(scheduleMobilePomodoroCompletionNotification).mockClear();
    storeState.settings = { notificationsEnabled: false, gtd: { pomodoro: {} } };

    const phaseEndsAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    mockStorage({
      '@mindwtr_pomodoro_state': JSON.stringify({
        durations: { focusMinutes: 25, breakMinutes: 5 },
        timerState: { phase: 'focus', remainingSeconds: 600, isRunning: true, completedFocusSessions: 0 },
        phaseEndsAt,
      }),
    });

    const tree = await renderPanel();

    expect(scheduleMobilePomodoroCompletionNotification).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      new Date(phaseEndsAt),
      { phase: 'focus-complete' },
    );

    tree.unmount();
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
});
