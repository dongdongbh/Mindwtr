import { describe, expect, it } from 'vitest';

import { createPomodoroState, DEFAULT_POMODORO_DURATIONS } from './pomodoro';
import {
  buildWatchApplicationContext,
  watchPomodoroPublicationKey,
  WATCH_DETAILS_BUDGET,
  WATCH_FOCUS_TASK_LIMIT,
  WATCH_TITLE_LIMIT,
  type WatchFocusItem,
  type WatchPomodoroState,
} from './watch-snapshot';

const pomodoro = (overrides: Partial<WatchPomodoroState> = {}): WatchPomodoroState => ({
  timerState: createPomodoroState(DEFAULT_POMODORO_DURATIONS),
  isHydrating: false,
  ...overrides,
});
const encodedSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const snapshot = (focus: readonly WatchFocusItem[]) => buildWatchApplicationContext({
  focus,
  pomodoro: pomodoro(),
  now: new Date(0),
});

describe('Watch snapshot wire format', () => {
  it('preserves ordered valid identities, deduplicates trimmed IDs, and bounds titles and task count', () => {
    const context = snapshot([
      { id: ' ', title: 'Blank ID' },
      { id: 'blank-title', title: ' \n ' },
      { id: ' first ', title: ' First ' },
      { id: 'first', title: 'Duplicate' },
      ...Array.from({ length: 30 }, (_, index) => ({ id: `${index}`, title: 'x'.repeat(200) })),
    ]);
    expect(context.focus).toHaveLength(WATCH_FOCUS_TASK_LIMIT);
    expect(context.focus[0]).toEqual({ id: 'first', title: 'First' });
    expect(context.focus.slice(1).map((item) => item.id)).toEqual(Array.from({ length: 19 }, (_, i) => `${i}`));
    expect(context.focus[1].title).toBe('x'.repeat(WATCH_TITLE_LIMIT));
    expect(Object.keys(context)).toEqual(['protocolVersion', 'generatedAt', 'focus', 'pomodoro']);
    expect(context.protocolVersion).toBe(1);
    expect(context.generatedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('retains the allowed detail fields and Unicode values without admitting extra task fields', () => {
    const item = {
      id: 'shopping', title: 'Shopping', createdAt: '2026-10-30T12:00:00.000Z',
      description: 'Line one\n牛奶 🥛',
      checklist: [{ id: 'milk', title: '牛奶 🥛', isCompleted: true }],
      privateField: 'omit', detailsUnavailable: true,
    };
    expect(snapshot([item]).focus).toEqual([{
      id: item.id, title: item.title, createdAt: item.createdAt,
      description: item.description, checklist: item.checklist,
    }]);
  });

  it('admits exactly 16 KiB of per-task details and rejects the next byte', () => {
    const overhead = encodedSize({ description: '' });
    const fits = 'a'.repeat(16 * 1024 - overhead);
    expect(snapshot([{ id: 'fits', title: 'Fits', description: fits }]).focus[0].description).toBe(fits);
    expect(snapshot([{ id: 'large', title: 'Large', description: `${fits}a` }]).focus[0]).toEqual({
      id: 'large', title: 'Large', detailsUnavailable: true,
    });
    expect(snapshot([{ id: 'unicode', title: 'Unicode', description: '😀'.repeat(4096) }]).focus[0].detailsUnavailable).toBe(true);
  });

  it('applies the total 40 KiB detail budget while keeping later small details eligible', () => {
    const overhead = encodedSize({ description: '' });
    const full = 'a'.repeat(16 * 1024 - overhead);
    const rest = 'b'.repeat(WATCH_DETAILS_BUDGET - 2 * 16 * 1024 - overhead);
    const context = snapshot([
      { id: '1', title: 'One', description: full },
      { id: '2', title: 'Two', description: full },
      { id: 'too-big', title: 'Too big', description: `${rest}b` },
      { id: 'rest', title: 'Rest', description: rest },
      { id: 'empty', title: 'Empty' },
    ]);
    expect(context.focus.map((item) => item.detailsUnavailable === true)).toEqual([false, false, true, false, true]);
    const admitted = context.focus.filter((item) => !item.detailsUnavailable);
    expect(admitted.reduce((bytes, item) => bytes + encodedSize({ description: item.description }), 0)).toBe(WATCH_DETAILS_BUDGET);
    expect(encodedSize(context)).toBeLessThan(60 * 1024);
  });

  it('keeps 100 checklist items, rejects 101, and omits empty optional detail values', () => {
    const checklist = Array.from({ length: 100 }, (_, i) => ({ id: `${i}`, title: `Item ${i}`, isCompleted: i === 0 }));
    expect(snapshot([{ id: '100', title: '100', checklist }]).focus[0].checklist).toEqual(checklist);
    expect(snapshot([{ id: '101', title: '101', checklist: [...checklist, checklist[0]] }]).focus[0]).toEqual({
      id: '101', title: '101', detailsUnavailable: true,
    });
    expect(snapshot([{ id: 'empty', title: 'Empty', description: '', createdAt: '', checklist: [] }]).focus[0]).toEqual({
      id: 'empty', title: 'Empty',
    });
  });

  it.each([
    { id: '', title: 'Item' },
    { id: ' padded ', title: 'Item' },
    { id: 'control\u0000', title: 'Item' },
    { id: 'control\u007f', title: 'Item' },
    { id: '牛'.repeat(171), title: 'Item' },
    { id: 'item', title: '😀'.repeat(2001) },
  ])('omits details with an invalid or oversized checklist entry: %j', (entry) => {
    expect(snapshot([{ id: 'task', title: 'Task', checklist: [{ ...entry, isCompleted: false }] }]).focus[0]).toEqual({
      id: 'task', title: 'Task', detailsUnavailable: true,
    });
  });

  it('preserves boolean and numeric transport and running timer/link optional keys', () => {
    const running = pomodoro({
      timerState: { ...createPomodoroState(DEFAULT_POMODORO_DURATIONS), phase: 'break', isRunning: true, remainingSeconds: 60.9 },
      phaseEndsAt: '2026-10-30T12:00:00.000Z', selectedTaskId: 'task',
    });
    const context = buildWatchApplicationContext({
      focus: [], pomodoro: running, linkedTask: { id: ' task ', title: ' Linked ' }, completionAlertEnabled: false,
    });
    expect(context.pomodoro).toEqual({
      phase: 'break', isRunning: true, remainingSeconds: 60, completionAlert: false,
      phaseEndTime: Date.parse('2026-10-30T12:00:00.000Z'), taskId: 'task', taskTitle: 'Linked',
    });
    expect(JSON.parse(JSON.stringify(context)).pomodoro).toEqual(context.pomodoro);
    expect(buildWatchApplicationContext({ focus: [], pomodoro: { ...running, phaseEndsAt: 'invalid' } }).pomodoro).not.toHaveProperty('phaseEndTime');
    const stopped = buildWatchApplicationContext({
      focus: [], pomodoro: pomodoro({ timerState: { ...running.timerState, isRunning: false, remainingSeconds: -0.5 }, phaseEndsAt: running.phaseEndsAt }),
      linkedTask: { id: ' ', title: 'Ignore' },
    });
    expect(stopped.pomodoro).toEqual({ phase: 'break', isRunning: false, remainingSeconds: 0, completionAlert: true });
    expect(buildWatchApplicationContext({ focus: [], pomodoro: running, linkedTask: { id: 'task', title: ' ' } }).pomodoro).not.toHaveProperty('taskTitle');
  });
});

describe('Watch Pomodoro publication key', () => {
  const running = pomodoro({
    timerState: { ...createPomodoroState(DEFAULT_POMODORO_DURATIONS), isRunning: true, remainingSeconds: 1499 },
    phaseEndsAt: '2026-10-30T12:00:00.000Z', selectedTaskId: 'task',
  });

  it('changes at displayed-minute boundaries and every stopped second', () => {
    expect(watchPomodoroPublicationKey(running)).toBe(JSON.stringify([false, 'focus', true, 25, running.phaseEndsAt, 'task']));
    expect(watchPomodoroPublicationKey({ ...running, timerState: { ...running.timerState, remainingSeconds: 1441 } })).toBe(watchPomodoroPublicationKey(running));
    expect(watchPomodoroPublicationKey({ ...running, timerState: { ...running.timerState, remainingSeconds: 1440 } })).not.toBe(watchPomodoroPublicationKey(running));
    const stopped = { ...running, timerState: { ...running.timerState, isRunning: false } };
    expect(watchPomodoroPublicationKey(stopped)).not.toBe(watchPomodoroPublicationKey({ ...stopped, timerState: { ...stopped.timerState, remainingSeconds: 1498 } }));
  });

  it.each([
    { isHydrating: true },
    { timerState: { ...running.timerState, phase: 'break' } },
    { timerState: { ...running.timerState, isRunning: false } },
    { phaseEndsAt: '2026-10-30T12:01:00.000Z' },
    { selectedTaskId: 'other-task' },
  ] satisfies Partial<WatchPomodoroState>[])('changes immediately for controller changes: %j', (change) => {
    expect(watchPomodoroPublicationKey({ ...running, ...change })).not.toBe(watchPomodoroPublicationKey(running));
  });
});
