import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useRootLayoutNotificationOpenHandler } from '@/app/_effects/use-root-layout-notification-open-handler';

type PendingNotificationOpenPayload = {
  actionIdentifier?: string;
  kind?: string;
  notificationId?: string;
  taskId?: string;
  projectId?: string;
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

vi.mock('@mindwtr/core', () => ({
  useTaskStore: {
    getState: () => ({
      _tasksById: storeTasksById,
      tasks: Array.from(storeTasksById.values()),
      setHighlightTask,
      updateTask,
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
    updateTask.mockClear();
    storeTasksById.clear();
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
      pathname: '/review-tab',
      params: { openToken: 'review-task-1', taskId: 'task-1' },
    });
    expect(router.push).toHaveBeenNthCalledWith(2, {
      pathname: '/review-tab',
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

  it('routes Android review alarm opens when only the alarm key is present', () => {
    const router = { push: vi.fn() };

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

  it('marks a task done from a complete notification action without navigating', () => {
    const router = { push: vi.fn() };
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
    const router = { push: vi.fn() };

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
