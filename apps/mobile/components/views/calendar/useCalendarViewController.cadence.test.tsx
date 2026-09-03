import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@mindwtr/core';

import { useCalendarViewController } from './useCalendarViewController';

type MockAppStateStatus = 'active' | 'background' | 'inactive';

const mocks = vi.hoisted(() => {
  const alert = vi.fn();
  const planningCandidates = vi.fn();
  return {
    alert,
    planningCandidates,
    areaById: new Map(),
    // Stable identity: the controller memoizes task filtering on it, and a
    // fresh object per render would fake an extra store expansion.
    areaFilterSelection: { included: [] as string[], excluded: [] as string[] },
    appState: { currentState: 'active' as MockAppStateStatus },
    appStateListeners: new Set<(state: MockAppStateStatus) => void>(),
    storeState: {
      tasks: [] as Task[],
      _allTasks: null as Task[] | null,
      projects: [] as any[],
      areas: [] as any[],
      // 'day' mode gives planningTasks a non-null selectedDate to work with;
      // the memo returns [] outright otherwise.
      settings: { calendar: { viewMode: 'day' }, weekStart: 'sunday' } as any,
      addProject: vi.fn(async () => null),
      addTask: vi.fn(async () => ({ success: true, id: 'task-new' })),
      updateTask: vi.fn(async () => ({ success: true })),
      deleteTask: vi.fn(async () => ({ success: true })),
      updateSettings: vi.fn(async () => undefined),
    },
  };
});

vi.mock('@mindwtr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mindwtr/core')>();
  return {
    ...actual,
    getCalendarPlanningCandidates: (...args: Parameters<typeof actual.getCalendarPlanningCandidates>) => {
      mocks.planningCandidates(...args);
      return actual.getCalendarPlanningCandidates(...args);
    },
    shallow: (a: unknown, b: unknown) => a === b,
    useTaskStore: (selector: (state: typeof mocks.storeState) => unknown) => selector(mocks.storeState),
  };
});

vi.mock('react-native', async () => {
  const actual = await vi.importActual<any>('react-native');
  return {
    ...actual,
    Alert: { ...actual.Alert, alert: mocks.alert },
    AppState: {
      get currentState() {
        return mocks.appState.currentState;
      },
      addEventListener: vi.fn((_event: string, listener: (state: MockAppStateStatus) => void) => {
        mocks.appStateListeners.add(listener);
        return {
          remove: () => mocks.appStateListeners.delete(listener),
        };
      }),
    },
  };
});

vi.mock('@react-navigation/native', () => ({
  useFocusEffect: () => undefined,
}));

vi.mock('../../../contexts/theme-context', () => ({
  useTheme: () => ({ isDark: false, themePreset: 'default' }),
}));

vi.mock('../../../contexts/toast-context', () => ({
  useToast: () => ({ showToast: vi.fn(), dismissToast: vi.fn() }),
}));

vi.mock('../../../contexts/language-context', () => ({
  useLanguage: () => ({ language: 'en', t: (key: string) => key }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({}),
}));

vi.mock('@/hooks/use-mobile-area-filter', () => ({
  useMobileAreaFilter: () => ({
    areaById: mocks.areaById,
    resolvedAreaFilter: mocks.areaFilterSelection,
  }),
}));

vi.mock('../../../lib/external-calendar', () => ({
  canOpenExternalCalendarEvent: () => false,
  fetchExternalCalendarEvents: vi.fn(async () => ({ calendars: [], events: [] })),
  openExternalCalendarEvent: vi.fn(async () => false),
}));

vi.mock('../../../lib/app-log', () => ({
  logError: vi.fn(async () => null),
}));

const makeTask = (overrides: Partial<Task>): Task => ({
  id: 'task-1',
  title: 'Plan the launch',
  status: 'next',
  tags: [],
  contexts: [],
  createdAt: '2026-04-01T00:00:00.000Z',
  updatedAt: '2026-04-01T00:00:00.000Z',
  ...overrides,
});

/** Bare host so the hook can be exercised without rendering the whole
 *  (much heavier) calendar-view screen -- this repo has no renderHook
 *  helper for mobile, so the host component stands in for one. */
function ControllerHost({ onResult }: { onResult: (value: ReturnType<typeof useCalendarViewController>) => void }) {
  const controller = useCalendarViewController();
  onResult(controller);
  return null;
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('useCalendarViewController cadence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-03T14:48:00.000Z'));
    mocks.appState.currentState = 'active';
    mocks.appStateListeners.clear();
    mocks.storeState.tasks = [];
    mocks.storeState._allTasks = null;
    mocks.storeState.updateTask.mockClear();
    mocks.storeState.deleteTask.mockClear();
    mocks.alert.mockClear();
    mocks.planningCandidates.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears the now-tick interval when backgrounded and restores it on foreground', async () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    await act(async () => {
      create(<ControllerHost onResult={() => undefined} />);
    });
    await flush();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    const listener = Array.from(mocks.appStateListeners)[0];
    expect(listener).toBeTypeOf('function');

    await act(async () => {
      listener('background');
    });
    // Going to background clears the running interval and does not start a
    // replacement.
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      listener('active');
    });
    // Returning to active starts a fresh interval.
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
  });

  it('starts the now-tick on mount when AppState reports inactive, not just active (correction #6)', async () => {
    // iOS reports 'inactive' (not 'active') for AppState.currentState during
    // a cold launch; only an explicit 'background' should hold the tick off.
    mocks.appState.currentState = 'inactive';
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    await act(async () => {
      create(<ControllerHost onResult={() => undefined} />);
    });
    await flush();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it('does not recompute planning candidates on an ordinary minute tick within the same day', async () => {
    mocks.storeState.tasks = [makeTask({})];

    await act(async () => {
      create(<ControllerHost onResult={() => undefined} />);
    });
    await flush();

    const callsAfterMount = mocks.planningCandidates.mock.calls.length;
    expect(callsAfterMount).toBeGreaterThan(0);

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });

    expect(mocks.planningCandidates).toHaveBeenCalledTimes(callsAfterMount);
  });
});
