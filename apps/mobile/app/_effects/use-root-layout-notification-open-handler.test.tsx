import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useRootLayoutNotificationOpenHandler } from './use-root-layout-notification-open-handler';

const {
  setNotificationOpenHandler,
  setHighlightTask,
} = vi.hoisted(() => ({
  setNotificationOpenHandler: vi.fn(),
  setHighlightTask: vi.fn(),
}));

vi.mock('@mindwtr/core', () => ({
  useTaskStore: {
    getState: () => ({
      setHighlightTask,
    }),
  },
}));

vi.mock('@/lib/notification-service', () => ({
  setNotificationOpenHandler,
}));

function TestHarness({ router }: { router: { push: ReturnType<typeof vi.fn> } }) {
  useRootLayoutNotificationOpenHandler({ router });
  return null;
}

describe('useRootLayoutNotificationOpenHandler', () => {
  beforeEach(() => {
    setNotificationOpenHandler.mockReset();
    setHighlightTask.mockReset();
  });

  it('routes review notifications to the dedicated review flows', () => {
    const router = { push: vi.fn() };

    act(() => {
      create(<TestHarness router={router} />);
    });

    const handler = setNotificationOpenHandler.mock.calls[0]?.[0];
    expect(typeof handler).toBe('function');

    act(() => {
      handler({ kind: 'daily-digest', notificationId: 'daily-1' });
      handler({ kind: 'weekly-review', notificationId: 'weekly-1' });
    });

    expect(router.push).toHaveBeenNthCalledWith(1, {
      pathname: '/daily-review',
      params: { openToken: 'daily-1' },
    });
    expect(router.push).toHaveBeenNthCalledWith(2, {
      pathname: '/weekly-review',
      params: { openToken: 'weekly-1' },
    });
  });

  it('still routes task notifications to the focus screen', () => {
    const router = { push: vi.fn() };

    act(() => {
      create(<TestHarness router={router} />);
    });

    const handler = setNotificationOpenHandler.mock.calls[0]?.[0];

    act(() => {
      handler({ taskId: 'task-1', notificationId: 'notif-1' });
    });

    expect(setHighlightTask).toHaveBeenCalledWith('task-1');
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/focus',
      params: { taskId: 'task-1', openToken: 'notif-1' },
    });
  });

  it('clears the notification handler on unmount', () => {
    const router = { push: vi.fn() };
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<TestHarness router={router} />);
    });

    act(() => {
      tree.unmount();
    });

    expect(setNotificationOpenHandler).toHaveBeenLastCalledWith(null);
  });
});
