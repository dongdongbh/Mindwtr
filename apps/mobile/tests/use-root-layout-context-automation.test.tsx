import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetContextAutomationDedupeForTests,
  useRootLayoutContextAutomation,
} from '@/hooks/root-layout/use-root-layout-context-automation';

const {
  mockStoreState,
  sendMobileImmediateNotification,
} = vi.hoisted(() => ({
  mockStoreState: {
    tasks: [] as any[],
    projects: [] as any[],
  },
  sendMobileImmediateNotification: vi.fn(async () => undefined),
}));

vi.mock('@mindwtr/core', async () => {
  const actual = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
  return {
    ...actual,
    useTaskStore: {
      getState: () => mockStoreState,
    },
  };
});

vi.mock('@/lib/notification-service', () => ({
  sendMobileImmediateNotification,
}));

const defaultResolveText = (_key: string, fallback: string) => fallback;

function TestHarness({
  incomingUrl,
  incomingUrlKey = incomingUrl ? 1 : 0,
  returnToBackground,
  resolveText = defaultResolveText,
}: {
  incomingUrl: string | null;
  incomingUrlKey?: number;
  returnToBackground?: ReturnType<typeof vi.fn>;
  resolveText?: (key: string, fallback: string) => string;
}) {
  useRootLayoutContextAutomation({
    dataReady: true,
    incomingUrl,
    incomingUrlKey,
    returnToBackground,
    resolveText,
  });
  return null;
}

describe('useRootLayoutContextAutomation', () => {
  beforeEach(() => {
    mockStoreState.tasks = [];
    mockStoreState.projects = [];
    sendMobileImmediateNotification.mockClear();
    __resetContextAutomationDedupeForTests();
  });

  it('notifies for context activation URLs without navigating the app shell', async () => {
    const returnToBackground = vi.fn();
    mockStoreState.tasks = [
      {
        id: 'task-1',
        title: 'Call mom',
        status: 'next',
        tags: [],
        contexts: ['@parents'],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'task-2',
        title: 'Waiting task',
        status: 'waiting',
        tags: [],
        contexts: ['@parents'],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    await act(async () => {
      create(
        <TestHarness
          incomingUrl="mindwtr://contexts?token=%40parents&contextAction=activate"
          returnToBackground={returnToBackground}
        />
      );
      await Promise.resolve();
    });

    expect(sendMobileImmediateNotification).toHaveBeenCalledWith(
      '@parents next action',
      'Call mom',
      {
        kind: 'context-automation',
        context: '@parents',
      }
    );
    expect(returnToBackground).toHaveBeenCalledTimes(1);
  });

  it('handles deactivation URLs silently', async () => {
    const returnToBackground = vi.fn();

    await act(async () => {
      create(
        <TestHarness
          incomingUrl="mindwtr:///context/deactivate/parents"
          returnToBackground={returnToBackground}
        />
      );
    });

    expect(sendMobileImmediateNotification).not.toHaveBeenCalled();
    expect(returnToBackground).toHaveBeenCalledTimes(1);
  });

  it('stays silent when context activation has no next actions', async () => {
    const returnToBackground = vi.fn();
    mockStoreState.tasks = [
      {
        id: 'task-1',
        title: 'Waiting task',
        status: 'waiting',
        tags: [],
        contexts: ['@parents'],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    await act(async () => {
      create(
        <TestHarness
          incomingUrl="mindwtr://contexts?token=%40parents&contextAction=activate"
          returnToBackground={returnToBackground}
        />
      );
    });

    expect(sendMobileImmediateNotification).not.toHaveBeenCalled();
    expect(returnToBackground).toHaveBeenCalledTimes(1);
  });

  it('deduplicates repeated activation URLs from remounts', async () => {
    const returnToBackground = vi.fn();
    mockStoreState.tasks = [
      {
        id: 'task-1',
        title: 'Call mom',
        status: 'next',
        tags: [],
        contexts: ['@parents'],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    await act(async () => {
      create(
        <TestHarness
          incomingUrl="mindwtr://contexts?token=%40parents&contextAction=activate"
          returnToBackground={returnToBackground}
        />
      );
      await Promise.resolve();
      create(
        <TestHarness
          incomingUrl="mindwtr://contexts?token=%40parents&contextAction=activate"
          returnToBackground={returnToBackground}
        />
      );
      await Promise.resolve();
    });

    expect(sendMobileImmediateNotification).toHaveBeenCalledTimes(1);
    expect(returnToBackground).toHaveBeenCalledTimes(2);
  });

  it('uses localized notification templates for context activation', async () => {
    const returnToBackground = vi.fn();
    const resolveText = (key: string, fallback: string) => ({
      'contextAutomation.oneNextActionTitle': 'Accion para {{context}}',
    }[key] ?? fallback);
    mockStoreState.tasks = [
      {
        id: 'task-1',
        title: 'Call mom',
        status: 'next',
        tags: [],
        contexts: ['@family'],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    await act(async () => {
      create(
        <TestHarness
          incomingUrl="mindwtr://contexts?token=%40family&contextAction=activate"
          returnToBackground={returnToBackground}
          resolveText={resolveText}
        />
      );
      await Promise.resolve();
    });

    expect(sendMobileImmediateNotification).toHaveBeenCalledWith(
      'Accion para @family',
      'Call mom',
      {
        kind: 'context-automation',
        context: '@family',
      }
    );
  });
});
