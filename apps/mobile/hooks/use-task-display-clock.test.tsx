import React from 'react';
import { AppState, Text } from 'react-native';
import type { AppStateStatus } from 'react-native';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTaskDisplayClock } from './use-task-display-clock';

function Probe({ enabled = true }: { enabled?: boolean }) {
  return <Text>{useTaskDisplayClock(enabled)}</Text>;
}

describe('useTaskDisplayClock', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('shares one timer/listener, pauses, refreshes within the same minute, and cleans up', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 9, 12, 59, 30));
    let onState!: (state: AppStateStatus) => void;
    const remove = vi.fn();
    const addListener = vi.spyOn(AppState, 'addEventListener').mockImplementation((_, listener) => {
      onState = listener;
      return { remove };
    });
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(<><Probe /><Probe /><Probe enabled={false} /></>); });
    try {
      expect(addListener).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
      const before = tree.root.findAllByType(Text)[0].props.children;
      renderer.act(() => { vi.advanceTimersByTime(30_000); });
      expect(tree.root.findAllByType(Text)[0].props.children).toBe(before);
      renderer.act(() => { vi.advanceTimersByTime(1); });
      expect(tree.root.findAllByType(Text)[0].props.children).toBe(before + 1);
      renderer.act(() => { onState('background'); });
      expect(vi.getTimerCount()).toBe(0);
      renderer.act(() => { vi.advanceTimersByTime(10_000); onState('active'); });
      expect(tree.root.findAllByType(Text)[0].props.children).toBe(before + 2);
      expect(vi.getTimerCount()).toBe(1);
      renderer.act(() => { tree.update(<Probe />); });
      expect(vi.getTimerCount()).toBe(1);
      expect(remove).not.toHaveBeenCalled();
    } finally {
      renderer.act(() => { tree.unmount(); });
    }
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('does no work while disabled or initially backgrounded', () => {
    vi.useFakeTimers();
    const addListener = vi.spyOn(AppState, 'addEventListener');
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(<Probe enabled={false} />); });
    expect(addListener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const originalState = AppState.currentState;
    AppState.currentState = 'background';
    try {
      renderer.act(() => { tree.update(<Probe />); });
      expect(addListener).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      AppState.currentState = originalState;
      renderer.act(() => { tree.unmount(); });
    }
  });
});
