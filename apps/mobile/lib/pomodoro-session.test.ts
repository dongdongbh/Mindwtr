import { describe, expect, it } from 'vitest';

import { DEFAULT_POMODORO_DURATIONS, createPomodoroState } from '@mindwtr/core';

import {
  pausePomodoroSession,
  resolvePomodoroSession,
  serializePomodoroSession,
  startPomodoroSession,
  type ResolvedPomodoroSession,
} from './pomodoro-session';

const baseSession = (overrides?: Partial<ResolvedPomodoroSession>): ResolvedPomodoroSession => ({
  durations: DEFAULT_POMODORO_DURATIONS,
  timerState: createPomodoroState(DEFAULT_POMODORO_DURATIONS),
  selectedTaskId: 'task-1',
  phaseEndsAt: undefined,
  lastEvent: null,
  ...overrides,
});

describe('pomodoro-session helpers', () => {
  it('keeps a running session aligned to its wall-clock end time', () => {
    const started = startPomodoroSession(baseSession({
      timerState: {
        phase: 'focus',
        remainingSeconds: 120,
        isRunning: false,
        completedFocusSessions: 0,
      },
    }), 1_000);

    const resolved = resolvePomodoroSession(serializePomodoroSession(started), 31_500);

    expect(resolved.timerState.isRunning).toBe(true);
    expect(resolved.timerState.remainingSeconds).toBe(90);
    expect(resolved.phaseEndsAt).toBe(started.phaseEndsAt);
    expect(resolved.lastEvent).toBeNull();
  });

  it('switches to a paused break when a focus session completes while inactive', () => {
    const running = startPomodoroSession(baseSession({
      timerState: {
        phase: 'focus',
        remainingSeconds: 5,
        isRunning: false,
        completedFocusSessions: 2,
      },
    }), 10_000);

    const resolved = resolvePomodoroSession(serializePomodoroSession(running), 16_000);

    expect(resolved.timerState).toEqual({
      phase: 'break',
      remainingSeconds: DEFAULT_POMODORO_DURATIONS.breakMinutes * 60,
      isRunning: false,
      completedFocusSessions: 3,
    });
    expect(resolved.phaseEndsAt).toBeUndefined();
    expect(resolved.lastEvent).toBe('focus-finished');
  });

  it('keeps the next break running when auto-start breaks is enabled', () => {
    const running = startPomodoroSession(baseSession({
      timerState: {
        phase: 'focus',
        remainingSeconds: 5,
        isRunning: false,
        completedFocusSessions: 2,
      },
    }), 10_000);

    const resolved = resolvePomodoroSession(serializePomodoroSession(running), 16_000, {
      autoStartBreaks: true,
    });

    expect(resolved.timerState).toEqual({
      phase: 'break',
      remainingSeconds: DEFAULT_POMODORO_DURATIONS.breakMinutes * 60 - 1,
      isRunning: true,
      completedFocusSessions: 3,
    });
    expect(resolved.phaseEndsAt).toBeDefined();
    expect(resolved.lastEvent).toBe('focus-finished');
  });

  it('pauses a running session with the remaining wall-clock time', () => {
    const running = startPomodoroSession(baseSession({
      timerState: {
        phase: 'break',
        remainingSeconds: 75,
        isRunning: false,
        completedFocusSessions: 1,
      },
    }), 5_000);

    const paused = pausePomodoroSession(running, 35_100);

    expect(paused.timerState).toEqual({
      phase: 'break',
      remainingSeconds: 45,
      isRunning: false,
      completedFocusSessions: 1,
    });
    expect(paused.phaseEndsAt).toBeUndefined();
    expect(paused.lastEvent).toBeNull();
  });

  it('falls back to a paused timer when stored running data is missing a valid end time', () => {
    const resolved = resolvePomodoroSession({
      durations: { focusMinutes: 15, breakMinutes: 3 },
      timerState: {
        phase: 'focus',
        remainingSeconds: 42,
        isRunning: true,
        completedFocusSessions: 0,
      },
      selectedTaskId: 'task-1',
      phaseEndsAt: 'not-a-date',
    }, 50_000);

    expect(resolved.timerState).toEqual({
      phase: 'focus',
      remainingSeconds: 42,
      isRunning: false,
      completedFocusSessions: 0,
    });
    expect(resolved.phaseEndsAt).toBeUndefined();
  });
});
