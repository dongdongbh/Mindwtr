import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useRootLayoutNotificationOpenHandler } from '@/hooks/root-layout/use-root-layout-notification-open-handler';

type PendingNotificationOpenPayload = {
  actionIdentifier?: string;
  kind?: string;
  notificationId?: string;
  taskId?: string;
  projectId?: string;
  context?: string;
} | null;

const {
  setNotificationOpenHandler,
  setHighlightTask,
  updateTask,
  storeTasksById,
  consumePendingNotificationOpenPayload,
} = vi.hoisted(() => ({
  setNotificationOpenHandler: vi.fn(),
  setHighlightTask: vi.fn(),
  updateTask: vi.fn(async () => undefined),
  storeTasksById: new Map<string, any>(),
  consumePendingNotificationOpenPayload: vi.fn<() => Promise<PendingNotificationOpenPayload>>(async () => null),
}));

vi.mock('@mindwtr/core', async (importOriginal) => {
  const { mockCore } = await import('../test-support/mock-core');
  return mockCore(importOriginal, () => ({
    _tasksById: storeTasksById,
    tasks: Array.from(storeTasksById.values()),
    setHighlightTask,
    updateTask,
  }));
});

vi.mock('@/lib/notification-service', () => ({
  setNotificationOpenHandler,
}));

vi.mock('@/modules/notification-open-intents', () => ({
  consumePendingNotificationOpenPayload,
}));

type NotificationRouter = Parameters<typeof useRootLayoutNotificationOpenHandler>[0]['router'];
const createRouter = () => ({ push: vi.fn<NotificationRouter['push']>() });

function TestHarness({ router }: { router: NotificationRouter }) {
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
  router: NotificationRouter;
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
    updateTask.mockClear();
    storeTasksById.clear();
    consumePendingNotificationOpenPayload.mockReset();
    consumePendingNotificationOpenPayload.mockResolvedValue(null);
  });

  it('routes review notifications to the dedicated review flows', () => {
    const router = createRouter();

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
    const router = createRouter();

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
      pathname: '/review-tab',
      params: { openToken: 'review-task-1', taskId: 'task-1' },
    });
    expect(router.push).toHaveBeenNthCalledWith(2, {
      pathname: '/review-tab',
      params: { openToken: 'review-project-1', projectId: 'project-1' },
    });
  });

  it('replays a pending Android notification open on mount', async () => {
    const router = createRouter();
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

  it('routes Android review alarm opens when only the alarm key is present', () => {
    const router = createRouter();

    act(() => {
      create(<TestHarness router={router} />);
    });

    const handler = setNotificationOpenHandler.mock.calls[0]?.[0];

    act(() => {
      handler({ notificationId: 'digest:evening' });
      handler({ notificationId: 'digest:weekly-review' });
    });

    expect(router.push).toHaveBeenNthCalledWith(1, {
      pathname: '/daily-review',
      params: { openToken: 'digest:evening' },
    });
    expect(router.push).toHaveBeenNthCalledWith(2, {
      pathname: '/weekly-review',
      params: { openToken: 'digest:weekly-review' },
    });
  });

  it('routes context automation notification taps to the matching Contexts screen', () => {
    const router = createRouter();

    act(() => {
      create(<TestHarness router={router} />);
    });

    const handler = setNotificationOpenHandler.mock.calls[0]?.[0];

    act(() => {
      handler({ kind: 'context-automation', context: '@parents', notificationId: 'context-parents' });
    });

    expect(router.push).toHaveBeenCalledWith({
      pathname: '/contexts',
      params: { token: '@parents' },
    });
  });

  it('waits for app readiness before replaying a pending open from the root path', async () => {
    const router = createRouter();
    consumePendingNotificationOpenPayload.mockResolvedValue({
      kind: 'task-reminder',
      notificationId: 'pending-task',
      taskId: 'task-1',
    });

    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TestHarnessWithState appReady={false} pathname="/" router={router} />);
    });

    expect(router.push).not.toHaveBeenCalled();

    await act(async () => {
      tree.update(<TestHarnessWithState appReady pathname="/" router={router} />);
    });

    expect(setHighlightTask).toHaveBeenCalledWith('task-1');
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/focus',
      params: expect.objectContaining({
        taskId: 'task-1',
        taskTab: 'view',
      }),
    });
  });

  it('routes task notification taps with a fresh open token so the editor can reopen', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(12345);
    const router = createRouter();

    try {
      act(() => {
        create(<TestHarness router={router} />);
      });

      const handler = setNotificationOpenHandler.mock.calls[0]?.[0];

      act(() => {
        handler({ taskId: 'task-1', notificationId: 'notif-1' });
        handler({ taskId: 'task-1', notificationId: 'notif-1' });
      });

      expect(setHighlightTask).toHaveBeenCalledWith('task-1');
      expect(router.push).toHaveBeenNthCalledWith(1, {
        pathname: '/focus',
        params: { taskId: 'task-1', openToken: 'notif-1:12345:1', taskTab: 'view' },
      });
      expect(router.push).toHaveBeenNthCalledWith(2, {
        pathname: '/focus',
        params: { taskId: 'task-1', openToken: 'notif-1:12345:2', taskTab: 'view' },
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('marks a task done from a complete notification action without navigating', () => {
    const router = createRouter();
    storeTasksById.set('task-1', {
      id: 'task-1',
      title: 'Pay rent',
      status: 'next',
    });

    act(() => {
      create(<TestHarness router={router} />);
    });

    const handler = setNotificationOpenHandler.mock.calls[0]?.[0];

    act(() => {
      handler({ actionIdentifier: 'complete', taskId: 'task-1', notificationId: 'notif-1' });
      handler({ actionIdentifier: 'complete', taskId: 'task-1', notificationId: 'notif-1' });
    });

    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledWith('task-1', {
      status: 'done',
      isFocusedToday: false,
    });
    expect(setHighlightTask).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('ignores snooze and dismiss notification actions', () => {
    const router = createRouter();

    act(() => {
      create(<TestHarness router={router} />);
    });

    const handler = setNotificationOpenHandler.mock.calls[0]?.[0];

    act(() => {
      handler({ actionIdentifier: 'snooze', taskId: 'task-1', notificationId: 'notif-1' });
      handler({ actionIdentifier: 'dismiss', taskId: 'task-1', notificationId: 'notif-2' });
    });

    expect(updateTask).not.toHaveBeenCalled();
    expect(setHighlightTask).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('clears the notification handler on unmount', () => {
    const router = createRouter();
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
