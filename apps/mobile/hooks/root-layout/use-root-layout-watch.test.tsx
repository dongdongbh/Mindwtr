import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  activateWatchConnectivity: vi.fn(async () => undefined),
  addPendingWatchCaptureListener: vi.fn((_listener: () => void) => ({ remove: vi.fn() })),
  updateWatchApplicationContext: vi.fn(async (_context: unknown) => undefined),
  subscribeStore: vi.fn(() => () => undefined),
}));

vi.mock('@mindwtr/core', async () => {
  const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
  const state = { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} };
  return { ...actual, useTaskStore: { getState: () => state, subscribe: mocks.subscribeStore } };
});
vi.mock('react-native', async () => {
  const actual = await vi.importActual<typeof import('react-native')>('react-native');
  return { ...actual, AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) } };
});
vi.mock('@/modules/watch-connectivity', () => ({
  activateWatchConnectivity: mocks.activateWatchConnectivity,
  addPendingWatchCaptureListener: mocks.addPendingWatchCaptureListener,
  isWatchConnectivityAvailable: () => true,
  updateWatchApplicationContext: mocks.updateWatchApplicationContext,
}));
vi.mock('@/lib/app-log', () => ({ logInfo: vi.fn(async () => undefined), logWarn: vi.fn(async () => undefined) }));
vi.mock('@/lib/pomodoro-controller', () => ({
  mobilePomodoroController: { getSnapshot: () => ({}), subscribe: () => () => undefined },
}));
vi.mock('@/lib/focus-widget-filter', () => ({ getFocusWidgetFilter: () => undefined }));
vi.mock('@/lib/widget-data', () => ({ buildWidgetPayload: () => ({ sections: [] }) }));
vi.mock('@/lib/watch-snapshot', () => ({
  buildWatchApplicationContext: () => ({ focus: [], pomodoro: { phase: 'focus', isRunning: false } }),
  watchPomodoroPublicationKey: () => 'idle',
}));

// eslint-disable-next-line import/first
import { useRootLayoutWatch } from './use-root-layout-watch';

const onPendingCapture = vi.fn();

function Harness({ canonicalDataReady }: { canonicalDataReady: boolean }) {
  useRootLayoutWatch({ canonicalDataReady, language: 'en', onPendingCapture });
  return null;
}

describe('useRootLayoutWatch', () => {
  beforeEach(() => vi.clearAllMocks());

  // The Watch keeps the last Focus list it was sent, and its capture wake-up
  // drains the queue. Neither may run on the startup snapshot. A wake-up
  // missed before then is harmless: its capture waits as a queue file.
  it('does not publish to the Watch or listen for captures before canonical data', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<Harness canonicalDataReady={false} />); });

    expect(mocks.activateWatchConnectivity).not.toHaveBeenCalled();
    expect(mocks.addPendingWatchCaptureListener).not.toHaveBeenCalled();
    expect(mocks.updateWatchApplicationContext).not.toHaveBeenCalled();
    expect(mocks.subscribeStore).not.toHaveBeenCalled();

    await act(async () => { tree.update(<Harness canonicalDataReady />); });
    expect(mocks.activateWatchConnectivity).toHaveBeenCalledOnce();
    expect(mocks.addPendingWatchCaptureListener).toHaveBeenCalledOnce();
    const listener = mocks.addPendingWatchCaptureListener.mock.calls[0][0];
    await vi.waitFor(() => expect(mocks.updateWatchApplicationContext).toHaveBeenCalledOnce());
    const firstContext = mocks.updateWatchApplicationContext.mock.calls[0][0];
    expect(onPendingCapture).not.toHaveBeenCalled();
    act(() => listener());
    expect(onPendingCapture).toHaveBeenCalledOnce();
    expect(onPendingCapture).toHaveBeenCalledWith();
    expect(mocks.updateWatchApplicationContext).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(mocks.updateWatchApplicationContext).toHaveBeenCalledTimes(2));
    expect(mocks.updateWatchApplicationContext).toHaveBeenNthCalledWith(2, firstContext);
    expect(onPendingCapture.mock.invocationCallOrder[0]).toBeLessThan(mocks.updateWatchApplicationContext.mock.invocationCallOrder[1]);
    act(() => tree.unmount());
  });
});
