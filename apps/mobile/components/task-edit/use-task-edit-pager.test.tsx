import React from 'react';
import { Keyboard } from 'react-native';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useTaskEditPager } from './use-task-edit-pager';

type PagerApi = ReturnType<typeof useTaskEditPager>;

const renderPager = () => {
  const api: { current: PagerApi | null } = { current: null };
  function Harness() {
    api.current = useTaskEditPager({
      editTab: 'task',
      isMarkdownOverlayOpen: false,
      setEditTab: () => {},
      taskId: 'task-1',
      visible: true,
    });
    return null;
  }
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(<Harness />);
  });
  return { api, tree };
};

describe('useTaskEditPager focus scroll target (#921)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('keeps the focus scroll target when a transient undefined arrives before the keyboard opens', () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (event?: unknown) => void>();
    vi.spyOn(Keyboard, 'addListener').mockImplementation(((eventName: string, listener: (event?: unknown) => void) => {
      listeners.set(eventName, listener);
      return { remove: () => listeners.delete(eventName) };
    }) as any);

    const { api } = renderPager();
    const scrollToEnd = vi.fn();
    act(() => {
      api.current!.registerScrollTaskFormToEnd(scrollToEnd);
    });


    act(() => {
      api.current!.handleInputFocus(4242);
      api.current!.handleInputFocus(undefined);
    });

    act(() => {
      listeners.get('keyboardDidShow')?.();
    });

    expect(scrollToEnd).toHaveBeenCalledWith(4242);
  });

  it('stops re-scrolling once the keyboard is up so typing does not autoscroll', () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (event?: unknown) => void>();
    vi.spyOn(Keyboard, 'addListener').mockImplementation(((eventName: string, listener: (event?: unknown) => void) => {
      listeners.set(eventName, listener);
      return { remove: () => listeners.delete(eventName) };
    }) as any);

    const { api } = renderPager();
    const scrollToEnd = vi.fn();
    act(() => {
      api.current!.registerScrollTaskFormToEnd(scrollToEnd);
    });

    act(() => {
      api.current!.handleInputFocus(4242);
      listeners.get('keyboardDidShow')?.();
    });
    scrollToEnd.mockClear();


    act(() => {
      api.current!.handleInputFocus(undefined);
      listeners.get('keyboardDidShow')?.();
    });

    expect(scrollToEnd).not.toHaveBeenCalled();
  });
});
