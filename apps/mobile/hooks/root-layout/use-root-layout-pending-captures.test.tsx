import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const allTasks = [{ id: 'deleted-capture', deletedAt: '2026-09-08T00:00:00.000Z' }];
  const state = {
    addTask: vi.fn(),
    updateTask: vi.fn(),
    addProject: vi.fn(),
    projects: [],
    areas: [],
    tasks: [],
    _allTasks: allTasks,
    people: [],
    settings: {},
  };
  return {
    allTasks,
    state,
    flushPendingTaskActionSave: vi.fn(async () => undefined),
    ingestPendingCaptures: vi.fn<typeof import('@/lib/pending-captures').ingestPendingCaptures>(async () => 0),
    transcribePendingAudio: vi.fn(),
    applyWatchCommand: vi.fn(),
    ingestIosWidgetCompletions: vi.fn(async () => 0),
    getNextPendingCompletionAt: vi.fn<() => Promise<number | null>>(async () => null),
    refreshWidgets: vi.fn(async () => true),
    appState: 'active',
    listeners: new Set<(state: string) => void>(),
  };
});

vi.mock('react-native', () => ({ AppState: {
  get currentState() { return mocks.appState; },
  addEventListener: (_event: string, listener: (state: string) => void) => {
    mocks.listeners.add(listener);
    return { remove: () => mocks.listeners.delete(listener) };
  },
} }));
vi.mock('@mindwtr/core', () => ({
  useTaskStore: { getState: () => mocks.state },
}));
vi.mock('@/lib/pending-captures', () => ({
  ingestPendingCaptures: mocks.ingestPendingCaptures,
}));
vi.mock('@/lib/pending-capture-persistence', () => ({
  flushPendingTaskActionSave: mocks.flushPendingTaskActionSave,
}));
vi.mock('@/lib/ios-widget-completions', () => ({
  ingestIosWidgetCompletions: mocks.ingestIosWidgetCompletions,
}));
vi.mock('../../modules/ios-widget', () => ({ getNextPendingCompletionAt: mocks.getNextPendingCompletionAt }));
vi.mock('@/lib/widget-service', () => ({ updateMobileWidgetFromStore: mocks.refreshWidgets }));
vi.mock('@/lib/watch-audio', () => ({
  transcribePendingAudio: mocks.transcribePendingAudio,
}));
vi.mock('@/lib/pomodoro-controller', () => ({
  mobilePomodoroController: { applyWatchCommand: mocks.applyWatchCommand },
}));
vi.mock('@/lib/app-log', () => ({ logError: vi.fn(async () => undefined) }));

// eslint-disable-next-line import/first
import { useRootLayoutPendingCaptures } from './use-root-layout-pending-captures';

function Harness({ dataReady = true, disabled = false }: { dataReady?: boolean; disabled?: boolean }) {
  useRootLayoutPendingCaptures({ dataReady, disabled });
  return null;
}

describe('useRootLayoutPendingCaptures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getNextPendingCompletionAt.mockResolvedValue(null);
    mocks.appState = 'active';
    mocks.listeners.clear();
  });
  afterEach(() => vi.useRealTimers());

  it('drains with the neutral audio transcriber and fresh tasks including tombstones', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<Harness />);
      await Promise.resolve();
    });

    expect(mocks.ingestPendingCaptures).toHaveBeenCalledOnce();
    const deps = mocks.ingestPendingCaptures.mock.calls[0][0];
    expect(deps.transcribeAudio).toBe(mocks.transcribePendingAudio);
    expect(deps.getTasks?.()).toBe(mocks.allTasks);
    expect(deps.flushPendingSave).toBe(mocks.flushPendingTaskActionSave);
    expect(mocks.ingestIosWidgetCompletions).toHaveBeenCalledWith(expect.objectContaining({
      updateTask: mocks.state.updateTask,
      flushPendingSave: mocks.flushPendingTaskActionSave,
      refreshWidgets: mocks.refreshWidgets,
    }));

    act(() => tree.unmount());
  });

  it('does not drain before store data is ready', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<Harness dataReady={false} />);
    });

    expect(mocks.ingestPendingCaptures).not.toHaveBeenCalled();
    expect(mocks.ingestIosWidgetCompletions).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('leaves the personal pending-capture queue untouched when disabled', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<Harness disabled />);
    });

    expect(mocks.ingestPendingCaptures).not.toHaveBeenCalled();
    expect(mocks.getNextPendingCompletionAt).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('drains once after the undo grace period, then stops scheduling', async () => {
    vi.useFakeTimers();
    mocks.getNextPendingCompletionAt.mockResolvedValueOnce(Date.now() + 3000);
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness />); });
    expect(mocks.ingestIosWidgetCompletions).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2999); });
    expect(mocks.ingestIosWidgetCompletions).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mocks.ingestIosWidgetCompletions).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    act(() => tree.unmount());
  });

  it('cancels the grace timer on unmount or sandbox entry', async () => {
    vi.useFakeTimers();
    mocks.getNextPendingCompletionAt.mockResolvedValue(Date.now() + 3000);
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness />); });
    expect(vi.getTimerCount()).toBe(1);
    act(() => tree.update(<Harness disabled />));
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(mocks.ingestIosWidgetCompletions).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it('cancels the grace timer in background and drains on the next foreground', async () => {
    vi.useFakeTimers();
    mocks.getNextPendingCompletionAt.mockResolvedValueOnce(Date.now() + 3000);
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness />); });
    expect(vi.getTimerCount()).toBe(1);
    act(() => { mocks.listeners.forEach((listener) => listener('background')); });
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(mocks.ingestIosWidgetCompletions).toHaveBeenCalledTimes(1);
    await act(async () => { mocks.listeners.forEach((listener) => listener('active')); });
    expect(mocks.ingestIosWidgetCompletions).toHaveBeenCalledTimes(2);
    act(() => tree.unmount());
  });

  it('does not schedule a timer when backgrounded while the native deadline read is pending', async () => {
    vi.useFakeTimers();
    let resolveDeadline!: (value: number) => void;
    mocks.getNextPendingCompletionAt.mockImplementationOnce(() => new Promise((resolve) => { resolveDeadline = resolve; }));
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness />); });
    await act(async () => {
      mocks.listeners.forEach((listener) => listener('background'));
      resolveDeadline(Date.now() + 3000);
    });
    expect(vi.getTimerCount()).toBe(0);
    act(() => tree.unmount());
  });
});
