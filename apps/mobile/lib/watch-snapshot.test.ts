import { describe, expect, it } from 'vitest';

import { DEFAULT_POMODORO_DURATIONS, createPomodoroState } from '@mindwtr/core';

import { buildWatchApplicationContext, WATCH_FOCUS_TASK_LIMIT, WATCH_TITLE_LIMIT, watchPomodoroPublicationKey } from './watch-snapshot';
import type { MobilePomodoroControllerState } from './pomodoro-controller';

const pomodoro = (overrides: Partial<MobilePomodoroControllerState> = {}): MobilePomodoroControllerState => ({
  durations: DEFAULT_POMODORO_DURATIONS,
  timerState: createPomodoroState(DEFAULT_POMODORO_DURATIONS),
  phaseEndsAt: undefined,
  selectedTaskId: undefined,
  lastEvent: null,
  sessionHistory: {
    totalCompletedFocusSessions: 0,
    completedFocusSessionsByTaskId: {},
    todayDayKey: '1970-01-01',
    completedTodayFocusSessions: 0,
  },
  isHydrating: false,
  updatedAtMs: 0,
  ...overrides,
});

describe('Watch application context', () => {
  it('retains complete Unicode details within the budget and explicitly omits oversized lists', () => {
    const checklist = Array.from({ length: 50 }, (_, i) => ({ id: `${i}`, title: `牛奶 🥛 ${i}`, isCompleted: i === 0 }));
    const small = { id: 'shopping', title: 'Shopping', description: 'Line one\nLine two', checklist };
    const result = buildWatchApplicationContext({ focus: [small], pomodoro: pomodoro() });
    expect(result.focus[0]).toEqual(small);
    const focus = Array.from({ length: 20 }, (_, i) => ({ ...small, id: `${i}`, description: '漢😀'.repeat(500) }));
    const bounded = buildWatchApplicationContext({ focus, pomodoro: pomodoro() });
    expect(new TextEncoder().encode(JSON.stringify(bounded)).length).toBeLessThan(60 * 1024);
    expect(bounded.focus.some((item) => item.detailsUnavailable)).toBe(true);
    for (const item of bounded.focus) expect(item.checklist === undefined || item.checklist.length === 50).toBe(true);
    const huge = buildWatchApplicationContext({ focus: [{ ...small, description: '😀'.repeat(10000) }], pomodoro: pomodoro() });
    expect(huge.focus[0]).toEqual({ id: 'shopping', title: 'Shopping', detailsUnavailable: true });
  });
  it('bounds and deduplicates Focus tasks and strips nullable timer fields', () => {
    const focus = Array.from({ length: 30 }, (_, index) => ({
      id: `task-${index}`,
      title: `Task ${index} ${'x'.repeat(300)}`,
    }));
    focus.splice(1, 0, focus[0]);

    const context = buildWatchApplicationContext({ focus, pomodoro: pomodoro(), now: new Date(0) });

    expect(context.focus).toHaveLength(WATCH_FOCUS_TASK_LIMIT);
    expect(context.focus[0].title.length).toBe(WATCH_TITLE_LIMIT);
    expect(context.generatedAt).toBe('1970-01-01T00:00:00.000Z');
    expect(context.pomodoro).toEqual({
      phase: 'focus',
      isRunning: false,
      remainingSeconds: DEFAULT_POMODORO_DURATIONS.focusMinutes * 60,
      completionAlert: true,
    });
    expect(JSON.stringify(context)).not.toContain('null');
  });

  it('publishes a running timer at minute rollover, not every second', () => {
    const first = pomodoro({
      timerState: { ...createPomodoroState(DEFAULT_POMODORO_DURATIONS), isRunning: true, remainingSeconds: 1499 },
      phaseEndsAt: '2026-09-07T00:00:00.000Z',
    });
    const sameMinute = pomodoro({ ...first, timerState: { ...first.timerState, remainingSeconds: 1498 } });
    const nextMinute = pomodoro({ ...first, timerState: { ...first.timerState, remainingSeconds: 1440 } });
    const alertsOff = buildWatchApplicationContext({
      focus: [],
      pomodoro: first,
      completionAlertEnabled: false,
    });

    expect(watchPomodoroPublicationKey(first)).toBe(watchPomodoroPublicationKey(sameMinute));
    expect(watchPomodoroPublicationKey(first)).not.toBe(watchPomodoroPublicationKey(nextMinute));
    expect(alertsOff.pomodoro.completionAlert).toBe(false);
  });
});
