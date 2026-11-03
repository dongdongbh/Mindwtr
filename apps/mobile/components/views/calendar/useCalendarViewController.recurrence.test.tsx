import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@mindwtr/core';

import { useCalendarViewController } from './useCalendarViewController';

const mocks = vi.hoisted(() => {
  const alert = vi.fn();
  return {
    alert,
    areaById: new Map(),


    areaFilterSelection: { included: [] as string[], excluded: [] as string[] },
    expandTaskSet: vi.fn(),
    storeState: {
      tasks: [] as Task[],
      _allTasks: null as Task[] | null,
      projects: [] as any[],
      areas: [] as any[],
      settings: { calendar: {}, weekStart: 'sunday' } as any,
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

    getCalendarRangeTasks: (...args: Parameters<typeof actual.getCalendarRangeTasks>) => {
      mocks.expandTaskSet(...args);
      return actual.getCalendarRangeTasks(...args);
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
  id: 'task-recurring-daily',
  title: 'Daily standup',
  status: 'next',
  tags: [],
  contexts: [],
  createdAt: '2026-04-01T00:00:00.000Z',
  updatedAt: '2026-04-01T00:00:00.000Z',
  ...overrides,
});


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

describe('useCalendarViewController recurrence range projection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-03T14:48:00.000Z'));
    mocks.storeState.tasks = [];
    mocks.storeState._allTasks = null;
    mocks.storeState.updateTask.mockClear();
    mocks.storeState.deleteTask.mockClear();
    mocks.alert.mockClear();
    mocks.expandTaskSet.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('paints a daily recurring task into every visible day of the month, read-only', async () => {
    mocks.storeState.tasks = [
      makeTask({ dueDate: '2026-04-02', recurrence: 'daily', showFutureRecurrence: true }),
    ];

    let controller!: ReturnType<typeof useCalendarViewController>;
    await act(async () => {
      create(<ControllerHost onResult={(value) => { controller = value; }} />);
    });
    await flush();


    const paintedDays: { date: number; hasReal: boolean; hasProjected: boolean }[] = [];
    for (let day = 2; day <= 30; day += 1) {
      const items = controller.getCalendarItemsForDate(new Date(2026, 3, day));
      const taskItems = items.filter((item): item is Extract<typeof item, { task: Task }> => 'task' in item);
      paintedDays.push({
        date: day,
        hasReal: taskItems.some((item) => item.task.id === 'task-recurring-daily'),
        hasProjected: taskItems.some((item) => item.task.id.startsWith('task-recurring-daily:projected-recurrence:')),
      });
    }

    expect(paintedDays.find((entry) => entry.date === 2)?.hasReal).toBe(true);
    const projectedDayCount = paintedDays.filter((entry) => entry.hasProjected).length;


    expect(projectedDayCount).toBeGreaterThan(20);


    const projectedItem = controller.getCalendarItemsForDate(new Date(2026, 3, 10))
      .find((item): item is Extract<typeof item, { task: Task }> => 'task' in item && item.task.id.startsWith('task-recurring-daily:projected-recurrence:'));
    expect(projectedItem).toBeDefined();

    await act(async () => {
      controller.commitTaskDrag(projectedItem!.task.id, Date.now(), 60, 30);
    });
    expect(mocks.storeState.updateTask).not.toHaveBeenCalled();

    await act(async () => {
      controller.openTaskActions(projectedItem!.task.id);
    });
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    expect(mocks.storeState.updateTask).not.toHaveBeenCalled();
    expect(mocks.storeState.deleteTask).not.toHaveBeenCalled();
  });

  it('shares the 500-occurrence cap across all recurring series', async () => {
    mocks.storeState.tasks = Array.from({ length: 20 }, (_, index) => makeTask({
      id: `task-recurring-${index}`,
      title: `Daily task ${index}`,
      dueDate: '2026-04-02',
      recurrence: 'daily',
      showFutureRecurrence: true,
    }));

    let controller!: ReturnType<typeof useCalendarViewController>;
    await act(async () => {
      create(<ControllerHost onResult={(value) => { controller = value; }} />);
    });
    await flush();

    const projectedIds = new Set<string>();
    for (let day = 1; day <= 30; day += 1) {
      controller.getCalendarItemsForDate(new Date(2026, 3, day)).forEach((item) => {
        if ('task' in item && item.task.id.includes(':projected-recurrence:')) {
          projectedIds.add(item.task.id);
        }
      });
    }

    expect(projectedIds).toHaveLength(500);
    for (let index = 0; index < 20; index += 1) {
      expect([...projectedIds].filter((id) => id.startsWith(`task-recurring-${index}:projected-recurrence:`))).toHaveLength(25);
    }
  });

  it('does not re-expand the task store on an ordinary minute tick', async () => {
    mocks.storeState.tasks = Array.from({ length: 5_000 }, (_, index) => makeTask({
      id: `task-${index}`,
      title: `Task ${index}`,
      dueDate: '2026-04-10',
    }));

    await act(async () => {
      create(<ControllerHost onResult={() => undefined} />);
    });
    await flush();
    const expansionCountAfterSettling = mocks.expandTaskSet.mock.calls.length;
    expect(expansionCountAfterSettling).toBeGreaterThan(0);

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });

    expect(mocks.expandTaskSet).toHaveBeenCalledTimes(expansionCountAfterSettling);
  });
});
