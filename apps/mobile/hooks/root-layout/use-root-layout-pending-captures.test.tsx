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
// The shared drain module also serves the background path, which owns these two.
vi.mock('@/lib/storage-adapter', () => ({ mobileStorage: {} }));
vi.mock('@/lib/file-system', () => ({ documentDirectory: null, getInfoAsync: vi.fn(), readDirectoryAsync: vi.fn() }));
vi.mock('../../modules/notification-open-intents', () => ({ peekPendingNotificationCompletions: vi.fn(async () => []) }));
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
vi.mock('@/lib/app-log', () => ({ logError: vi.fn(async () => undefined), logInfo: vi.fn(async () => undefined) }));

// eslint-disable-next-line import/first
import { logInfo } from '@/lib/app-log';
// eslint-disable-next-line import/first
import { useRootLayoutPendingCaptures } from './use-root-layout-pending-captures';

function Harness({ canonicalDataReady = true, disabled = false }: { canonicalDataReady?: boolean; disabled?: boolean }) {
  useRootLayoutPendingCaptures({ canonicalDataReady, disabled });
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

  // Before canonical data only the startup snapshot is in the store. A write
  // there makes core discard the SQLite load, so the queue waits on disk.
  it('holds the queue until canonical data is ready, then drains it once', async () => {
    let drain!: () => Promise<void>;
    function Probe({ canonicalDataReady }: { canonicalDataReady: boolean }) {
      drain = useRootLayoutPendingCaptures({ canonicalDataReady });
      return null;
    }
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Probe canonicalDataReady={false} />); });
    // A Watch wake-up before the load is a no-op, not a lost capture.
    await act(async () => { await drain(); });
    expect(mocks.ingestPendingCaptures).not.toHaveBeenCalled();
    expect(mocks.ingestIosWidgetCompletions).not.toHaveBeenCalled();

    await act(async () => { tree.update(<Probe canonicalDataReady />); });
    expect(mocks.ingestPendingCaptures).toHaveBeenCalledOnce();
    expect(mocks.ingestIosWidgetCompletions).toHaveBeenCalledOnce();
    expect(logInfo).toHaveBeenCalledWith('Startup capture drain ran after canonical data load', {
      scope: 'capture',
      extra: {
        releaseCheck: 'v1.3.3/mobile-startup-writes-after-canonical-load',
        elapsedMs: expect.any(Number),
        count: 0,
      },
    });

    // Later foregrounds drain again; the startup line stays one per launch.
    await act(async () => { mocks.listeners.forEach((listener) => listener('active')); });
    expect(mocks.ingestPendingCaptures).toHaveBeenCalledTimes(2);
    expect(vi.mocked(logInfo).mock.calls.filter(
      ([message]) => message === 'Startup capture drain ran after canonical data load',
    )).toHaveLength(1);
    act(() => tree.unmount());
  });

  it('refreshes widgets after a slow capture import finishes, not before it', async () => {
    let finishImport!: (count: number) => void;
    mocks.ingestPendingCaptures.mockImplementationOnce(() => new Promise((resolve) => { finishImport = resolve; }));
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness />); });
    expect(mocks.refreshWidgets).not.toHaveBeenCalled();

    await act(async () => { finishImport(1); });
    expect(mocks.refreshWidgets).toHaveBeenCalledOnce();
    expect(mocks.ingestPendingCaptures).toHaveBeenCalledOnce();
    act(() => tree.unmount());
  });

  it('does not refresh widgets for an empty pending queue', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness />); });
    expect(mocks.refreshWidgets).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('does not replay an imported capture when widget publication fails', async () => {
    mocks.ingestPendingCaptures.mockResolvedValueOnce(1);
    mocks.refreshWidgets.mockRejectedValueOnce(new Error('Widget unavailable'));
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness />); });
    expect(mocks.ingestPendingCaptures).toHaveBeenCalledOnce();
    expect(mocks.refreshWidgets).toHaveBeenCalledOnce();
    expect(mocks.ingestIosWidgetCompletions).toHaveBeenCalledOnce();
    act(() => tree.unmount());
  });

  it('does not publish personal widgets if disabled during capture import', async () => {
    let finishImport!: (count: number) => void;
    mocks.ingestPendingCaptures.mockImplementationOnce(() => new Promise((resolve) => { finishImport = resolve; }));
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness />); });
    act(() => tree.update(<Harness disabled />));
    await act(async () => { finishImport(1); });
    expect(mocks.refreshWidgets).not.toHaveBeenCalled();
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
