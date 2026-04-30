import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useRootLayoutNotificationOpenHandler } from '@/app/_effects/use-root-layout-notification-open-handler';

type PendingNotificationOpenPayload = {
  kind?: string;
  notificationId?: string;
  taskId?: string;
  projectId?: string;
} | null;

const {
  setNotificationOpenHandler,
  setHighlightTask,
  consumePendingNotificationOpenPayload,
} = vi.hoisted(() => ({
  setNotificationOpenHandler: vi.fn(),
  setHighlightTask: vi.fn(),
  consumePendingNotificationOpenPayload: vi.fn<() => Promise<PendingNotificationOpenPayload>>(async () => null),
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

vi.mock('@/modules/notification-open-intents', () => ({
  consumePendingNotificationOpenPayload,
}));

function TestHarness({ router }: { router: { push: ReturnType<typeof vi.fn> } }) {
  useRootLayoutNotificationOpenHandler({
    appReady: true,
    pathname: '/inbox',
    router,
  });
  return null;
}

function TestHarnessWithState({
  appReady,
  pathname,
  router,
}: {
  appReady: boolean;
  pathname?: string | null;
  router: { push: ReturnType<typeof vi.fn> };
}) {
  useRootLayoutNotificationOpenHandler({
    appReady,
    pathname,
    router,
  });
  return null;
}

describe('useRootLayoutNotificationOpenHandler', () => {
  beforeEach(() => {
    setNotificationOpenHandler.mockReset();
    setHighlightTask.mockReset();
    consumePendingNotificationOpenPayload.mockReset();
    consumePendingNotificationOpenPayload.mockResolvedValue(null);
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

  it('routes review date reminders to the review page before task or project fallbacks', () => {
    const router = { push: vi.fn() };

    act(() => {
      create(<TestHarness router={router} />);
    });

    const handler = setNotificationOpenHandler.mock.calls[0]?.[0];

    act(() => {
      handler({ kind: 'task-review', taskId: 'task-1', notificationId: 'review-task-1' });
      handler({ kind: 'project-review', projectId: 'project-1', notificationId: 'review-project-1' });
    });

    expect(setHighlightTask).not.toHaveBeenCalled();
    expect(router.push).toHaveBeenNthCalledWith(1, {
      pathname: '/review',
      params: { openToken: 'review-task-1', taskId: 'task-1' },
    });
    expect(router.push).toHaveBeenNthCalledWith(2, {
      pathname: '/review',
      params: { openToken: 'review-project-1', projectId: 'project-1' },
    });
  });

  it('replays a pending Android notification open on mount', async () => {
    const router = { push: vi.fn() };
    consumePendingNotificationOpenPayload.mockResolvedValue({
      kind: 'weekly-review',
      notificationId: 'pending-weekly',
    });

    await act(async () => {
      create(<TestHarness router={router} />);
    });

    expect(consumePendingNotificationOpenPayload).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/weekly-review',
      params: { openToken: 'pending-weekly' },
    });
  });

  it('waits for startup navigation to leave the root path before replaying a pending open', async () => {
    const router = { push: vi.fn() };
    consumePendingNotificationOpenPayload.mockResolvedValue({
      kind: 'weekly-review',
      notificationId: 'pending-weekly',
    });

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TestHarnessWithState appReady={false} pathname="/" router={router} />);
    });

    expect(router.push).not.toHaveBeenCalled();

    await act(async () => {
      tree.update(<TestHarnessWithState appReady pathname="/inbox" router={router} />);
    });

    expect(router.push).toHaveBeenCalledWith({
      pathname: '/weekly-review',
      params: { openToken: 'pending-weekly' },
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
