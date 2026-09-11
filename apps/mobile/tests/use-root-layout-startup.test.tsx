import React, { useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useRootLayoutStartup } from '@/hooks/root-layout/use-root-layout-startup';

const {
  alert,
  asyncStorageGetItem,
  asyncStorageSetItem,
  fetchData,
  getInstallReferrerAsync,
  getMobileStartupSnapshotFromBackup,
  logError,
  logInfo,
  markStartupPhase,
  measureStartupPhase,
  requestSync,
  setStateSpy,
  startMobileNotifications,
  storeHolder,
  updateMobileWidgetFromStore,
  verifyPolyfills,
} = vi.hoisted(() => ({
  alert: vi.fn(),
  asyncStorageGetItem: vi.fn<() => Promise<string | null>>(async () => null),
  asyncStorageSetItem: vi.fn<() => Promise<void>>(async () => undefined),
  fetchData: vi.fn<() => Promise<void>>(async () => undefined),
  getInstallReferrerAsync: vi.fn(async () => ''),
  getMobileStartupSnapshotFromBackup: vi.fn<() => Promise<any>>(async () => null),
  logError: vi.fn(async () => undefined),
  logInfo: vi.fn(async () => undefined),
  markStartupPhase: vi.fn(),
  measureStartupPhase: vi.fn(async (_name: string, fn: () => unknown | Promise<unknown>) => await fn()),
  requestSync: vi.fn(),
  setStateSpy: vi.fn(),
  startMobileNotifications: vi.fn(async () => undefined),
  storeHolder: { state: null as any },
  updateMobileWidgetFromStore: vi.fn(async () => true),
  verifyPolyfills: vi.fn(),
}));

vi.mock('react-native', async () => {
  const actual = await vi.importActual<typeof import('react-native')>('react-native');
  return {
    ...actual,
    Alert: {
      alert,
    },
    Platform: {
      ...actual.Platform,
      OS: 'android',
      Version: 34,
      constants: {
        Release: '14',
      },
    },
  };
});

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: asyncStorageGetItem,
    setItem: asyncStorageSetItem,
  },
}));

vi.mock('expo-application', () => ({
  getInstallReferrerAsync,
}));

vi.mock('@mindwtr/core', async () => {
  // hasActiveMobileNotificationFeature is a pure predicate (packages/core/src/schedule-utils.ts):
  // passthrough the real implementation rather than re-stub it here.
  const { hasActiveMobileNotificationFeature } = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
  return {
    generateUUID: () => 'generated-id',
    hasActiveMobileNotificationFeature,
    resetHeartbeatOptOutMarker: vi.fn(async () => undefined),
    sendDailyHeartbeat: vi.fn(async () => undefined),
    sendHeartbeatOptOut: vi.fn(async () => undefined),
    selectVisibleTasks: (tasks: Array<{ deletedAt?: string | null; status?: string }>) => (
      tasks.filter((task) => !task.deletedAt && task.status !== 'archived')
    ),
    SQLITE_SCHEMA_VERSION: 1,
    useTaskStore: {
      getState: () => storeHolder.state,
      setState: (partial: Record<string, unknown> | ((state: any) => Record<string, unknown>)) => {
        const nextPartial = typeof partial === 'function' ? partial(storeHolder.state) : partial;
        const nextState = {
          ...storeHolder.state,
          ...nextPartial,
        };
        if (Array.isArray(nextPartial._allTasks)) {
          nextState.tasks = nextPartial._allTasks.filter((task: any) => !task.deletedAt && task.status !== 'archived');
        }
        if (Array.isArray(nextPartial._allProjects)) {
          nextState.projects = nextPartial._allProjects.filter((project: any) => !project.deletedAt);
        }
        if (Array.isArray(nextPartial._allSections)) {
          nextState.sections = nextPartial._allSections.filter((section: any) => !section.deletedAt);
        }
        if (Array.isArray(nextPartial._allAreas)) {
          nextState.areas = nextPartial._allAreas.filter((area: any) => !area.deletedAt);
        }
        storeHolder.state = {
          ...nextState,
        };
        setStateSpy(nextPartial);
      },
    },
  };
});

vi.mock('@/lib/storage-adapter', () => ({
  getMobileStartupSnapshotFromBackup,
}));

vi.mock('@/lib/notification-service', () => ({
  startMobileNotifications,
}));

vi.mock('@/lib/widget-service', () => ({
  updateMobileWidgetFromStore,
}));

vi.mock('@/lib/startup-profiler', () => ({
  markStartupPhase,
  measureStartupPhase,
}));

vi.mock('@/utils/verify-polyfills', () => ({
  verifyPolyfills,
}));

vi.mock('@/lib/app-log', () => ({
  logError,
  logInfo,
}));

vi.mock('@/lib/sync-service-utils', () => ({
  coerceSupportedBackend: (backend: string | null) => backend ?? 'off',
  resolveBackend: (backend: string | null) => backend ?? 'off',
}));

vi.mock('@/lib/sync-constants', () => ({
  SYNC_BACKEND_KEY: 'sync-backend',
}));

vi.mock('@/lib/cloudkit-sync', () => ({
  isCloudKitAvailable: () => false,
}));

type HarnessProps = {
  onReadyChange: (ready: boolean) => void;
  onCanonicalChange?: (ready: boolean) => void;
  sandboxMode?: boolean;
};

function TestHarness({ onReadyChange, onCanonicalChange, sandboxMode = false }: HarnessProps) {
  const { dataReady, canonicalDataReady } = useRootLayoutStartup({
    analyticsHeartbeatUrl: '',
    appVersion: '0.8.3',
    isExpoGo: false,
    isFossBuild: false,
    requestSync,
    sandboxMode,
    storageInitError: null,
  });

  useEffect(() => {
    onReadyChange(dataReady);
  }, [dataReady, onReadyChange]);
  useEffect(() => { onCanonicalChange?.(canonicalDataReady); }, [canonicalDataReady, onCanonicalChange]);

  return null;
}

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const createDeferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

describe('useRootLayoutStartup', () => {
  beforeEach(() => {
    (globalThis as any).__DEV__ = false;
    alert.mockReset();
    asyncStorageGetItem.mockReset();
    asyncStorageSetItem.mockReset();
    asyncStorageGetItem.mockResolvedValue(null);
    asyncStorageSetItem.mockResolvedValue(undefined);
    fetchData.mockReset();
    fetchData.mockResolvedValue(undefined);
    getInstallReferrerAsync.mockReset();
    getInstallReferrerAsync.mockResolvedValue('');
    getMobileStartupSnapshotFromBackup.mockReset();
    getMobileStartupSnapshotFromBackup.mockResolvedValue(null);
    logError.mockReset();
    logInfo.mockReset();
    markStartupPhase.mockReset();
    measureStartupPhase.mockClear();
    requestSync.mockReset();
    setStateSpy.mockReset();
    startMobileNotifications.mockReset();
    updateMobileWidgetFromStore.mockReset();
    updateMobileWidgetFromStore.mockResolvedValue(true);
    verifyPolyfills.mockReset();
    storeHolder.state = {
      fetchData,
      settings: {},
      tasks: [],
      projects: [],
      sections: [],
      areas: [],
      _allTasks: [],
      _allProjects: [],
      _allSections: [],
      _allAreas: [],
    };
  });

  it('hydrates sandbox data without reading or starting personal services', async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<TestHarness sandboxMode onReadyChange={() => {}} />);
      await flushMicrotasks();
    });

    expect(fetchData).toHaveBeenCalledOnce();
    expect(getMobileStartupSnapshotFromBackup).not.toHaveBeenCalled();
    expect(asyncStorageGetItem).not.toHaveBeenCalled();
    expect(startMobileNotifications).not.toHaveBeenCalled();
    expect(updateMobileWidgetFromStore).not.toHaveBeenCalled();
    expect(requestSync).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith('Sandbox workspace bootstrapped', expect.objectContaining({
      scope: 'sandbox',
      extra: {
        releaseCheck: 'v1.3.0/sandbox-workspace',
        workspace: 'sandbox',
      },
    }));

    await act(async () => tree.unmount());
  });

  it('applies the backup snapshot before the canonical fetch finishes', async () => {
    const fetchDeferred = createDeferred<void>();
    const readyStates: boolean[] = [];
    const canonicalStates: boolean[] = [];
    let tree!: ReactTestRenderer;

    fetchData.mockImplementation(async () => {
      await fetchDeferred.promise;
    });
    getMobileStartupSnapshotFromBackup.mockResolvedValue({
      tasks: [
        {
          id: 'task-1',
          title: 'Local inbox task',
          status: 'inbox',
          createdAt: '2026-04-15T00:00:00.000Z',
          updatedAt: '2026-04-15T00:00:00.000Z',
        },
      ],
      projects: [],
      sections: [],
      areas: [],
      settings: {},
    });

    await act(async () => {
      tree = create(<TestHarness onReadyChange={(ready) => readyStates.push(ready)} onCanonicalChange={(ready) => canonicalStates.push(ready)} />);
      await flushMicrotasks();
    });

    expect(fetchData).toHaveBeenCalledWith({ silent: true });
    expect(setStateSpy).toHaveBeenCalledTimes(1);
    expect(storeHolder.state.tasks).toHaveLength(1);
    expect(storeHolder.state._allTasks).toHaveLength(1);
    expect(readyStates.at(-1)).toBe(true);
    expect(canonicalStates.at(-1)).toBe(false);
    expect(markStartupPhase).not.toHaveBeenCalledWith('js.local_data_ready');
    expect(requestSync).not.toHaveBeenCalled();

    await act(async () => {
      fetchDeferred.resolve();
      await flushMicrotasks();
    });

    expect(requestSync).toHaveBeenCalledWith(0);
    expect(canonicalStates.at(-1)).toBe(true);
    expect(markStartupPhase).toHaveBeenCalledWith('js.local_data_ready');

    act(() => {
      tree.unmount();
    });
  });

  it('ignores the backup snapshot when the canonical fetch already won the race', async () => {
    const backupDeferred = createDeferred<any>();
    const readyStates: boolean[] = [];
    let tree!: ReactTestRenderer;

    getMobileStartupSnapshotFromBackup.mockImplementation(() => backupDeferred.promise);

    await act(async () => {
      tree = create(<TestHarness onReadyChange={(ready) => readyStates.push(ready)} />);
      await flushMicrotasks();
    });

    expect(fetchData).toHaveBeenCalledWith({ silent: true });
    expect(requestSync).toHaveBeenCalledWith(0);
    expect(setStateSpy).not.toHaveBeenCalled();
    expect(readyStates.at(-1)).toBe(true);

    await act(async () => {
      backupDeferred.resolve({
        tasks: [
          {
            id: 'task-late',
            title: 'Late backup task',
            status: 'inbox',
            createdAt: '2026-04-15T00:00:00.000Z',
            updatedAt: '2026-04-15T00:00:00.000Z',
          },
        ],
        projects: [],
        sections: [],
        areas: [],
        settings: {},
      });
      await flushMicrotasks();
    });

    expect(setStateSpy).not.toHaveBeenCalled();
    expect(storeHolder.state.tasks).toHaveLength(0);

    act(() => {
      tree.unmount();
    });
  });

  it('never marks a terminal storage error as canonical readiness', async () => {
    fetchData.mockImplementation(async () => { storeHolder.state.error = 'Storage unavailable'; });
    const canonicalStates: boolean[] = [];
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<TestHarness onReadyChange={() => undefined} onCanonicalChange={(ready) => canonicalStates.push(ready)} />);
      await flushMicrotasks();
    });
    expect(canonicalStates).not.toContain(true);
    expect(markStartupPhase).not.toHaveBeenCalledWith('js.local_data_ready');
    act(() => tree.unmount());
  });
});
