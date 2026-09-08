import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { StartupReadinessContext, useStartupScreenReady } from '../hooks/use-startup-screen-ready';

const mocks = vi.hoisted(() => ({
  mark: vi.fn(), native: vi.fn(async () => false), log: vi.fn(async () => undefined),
  listeners: new Set<(state: string) => void>(),
  paints: [] as { callback: () => void; cancelled: boolean }[],
}));
vi.mock('react-native', () => ({ AppState: {
  currentState: 'active',
  addEventListener: (_: string, listener: (state: string) => void) => {
    mocks.listeners.add(listener);
    return { remove: () => mocks.listeners.delete(listener) };
  },
} }));
vi.mock('@mindwtr/core', () => ({ afterPaint: (callback: () => void) => {
  const entry = { callback, cancelled: false };
  mocks.paints.push(entry);
  return () => { entry.cancelled = true; };
} }));
vi.mock('../lib/startup-profiler', () => ({ markStartupPhase: mocks.mark, startupNow: () => 100, startupElapsedMs: () => 100 }));
vi.mock('../lib/app-log', () => ({ logInfo: mocks.log }));
vi.mock('../modules/startup-metrics', () => ({ reportFullyDrawn: mocks.native }));

function Screen() {
  const onLayout = useStartupScreenReady('inbox');
  return React.createElement('mock-view', { onLayout });
}
const renderScreen = (canonicalDataReady: boolean, pathname = '/inbox') => (
  <StartupReadinessContext.Provider value={{ canonicalDataReady, pathname }}><Screen /></StartupReadinessContext.Provider>
);
const paint = () => act(() => { for (const entry of mocks.paints.splice(0)) if (!entry.cancelled) entry.callback(); });

it('requires canonical data, active route, foreground and layout; cancels stale paints and reports resume separately', async () => {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(renderScreen(false)); });
  act(() => tree.root.find((node) => typeof node.props.onLayout === 'function').props.onLayout({ nativeEvent: { layout: { width: 0, height: 0 } } }));
  paint();
  expect(mocks.mark).not.toHaveBeenCalled();
  act(() => tree.root.find((node) => typeof node.props.onLayout === 'function').props.onLayout({ nativeEvent: { layout: { width: 300, height: 600 } } }));
  paint();
  expect(mocks.mark).not.toHaveBeenCalled();
  act(() => tree.update(renderScreen(true)));
  act(() => tree.update(renderScreen(true, '/focus')));
  paint();
  expect(mocks.mark).not.toHaveBeenCalled();
  act(() => { for (const listener of mocks.listeners) listener('background'); });
  act(() => tree.update(renderScreen(true)));
  paint();
  expect(mocks.mark).not.toHaveBeenCalled();
  act(() => { for (const listener of mocks.listeners) listener('active'); });
  paint();
  expect(mocks.mark).toHaveBeenCalledWith('js.interactive_ready', { route: 'inbox' });
  expect(mocks.native).toHaveBeenCalledOnce();
  expect(mocks.log).toHaveBeenCalledOnce();
  mocks.mark.mockClear();
  act(() => { for (const listener of mocks.listeners) listener('background'); });
  act(() => { for (const listener of mocks.listeners) listener('active'); });
  paint();
  expect(mocks.mark).toHaveBeenCalledExactlyOnceWith('js.resume_ready', { route: 'inbox', durationMs: 0 });
  act(() => tree.unmount());
  expect(mocks.listeners.size).toBe(0);
});
