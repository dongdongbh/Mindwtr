import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useRootLayoutSyncEffects } from '@/hooks/root-layout/use-root-layout-sync-effects';
import { getNotificationPermissionStatus, stopMobileNotifications } from '@/lib/notification-service';

const {
  abortMobileSync,
  appState,
  appStateListeners,
  asyncStorageGetItem,
  flushPendingSave,
  getInMemorySyncChangeFingerprint,
  getCalendarPushEnabled,
  hasActiveMobileNotificationFeature,
  performMobileSync,
  storeSubscribe,
  syncMobileBackgroundSyncRegistration,
  subscribeToCloudKitChanges,
  updateMobileWidgetFromStore,
} = vi.hoisted(() => ({
  abortMobileSync: vi.fn(() => true),
  appState: { currentState: 'active' },
  appStateListeners: new Set<(state: 'active' | 'background' | 'inactive') => void>(),
  asyncStorageGetItem: vi.fn(async () => 'cloud'),
  flushPendingSave: vi.fn(async () => undefined),
  getInMemorySyncChangeFingerprint: vi.fn(() => 'sync-change:initial'),
  getCalendarPushEnabled: vi.fn(async () => false),
  hasActiveMobileNotificationFeature: vi.fn(() => false),
  performMobileSync: vi.fn(async (): Promise<{ success: boolean; error?: string }> => ({ success: true })),
  storeSubscribe: vi.fn((..._args: unknown[]) => vi.fn()),
  syncMobileBackgroundSyncRegistration: vi.fn(async () => undefined),
  subscribeToCloudKitChanges: vi.fn((_listener: () => void) => vi.fn()),
  updateMobileWidgetFromStore: vi.fn(async () => true),
}));

vi.mock('react-native', async () => {
  const actual = await vi.importActual<typeof import('react-native')>('react-native');
  return {
    ...actual,
    AppState: {
      get currentState() {
        return appState.currentState;
      },
      addEventListener: vi.fn((_event: string, listener: (state: 'active' | 'background' | 'inactive') => void) => {
        appStateListeners.add(listener);
        return {
          remove: () => appStateListeners.delete(listener),
        };
      }),
    },
    Platform: {
      ...actual.Platform,
      OS: 'android',
    },
  };
});

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: asyncStorageGetItem,
  },
}));

vi.mock('@mindwtr/core', async () => {


  const { createAutoSyncController, resolveSyncFailureCooldownMs } = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
  return {
    createAutoSyncController,
    flushPendingSave,
    getInMemorySyncChangeFingerprint,
    hasActiveMobileNotificationFeature,
    nameNotifyListener: (_name: string, listener: unknown) => listener,
    resolveSyncFailureCooldownMs,
    useTaskStore: {
      getState: () => ({ settings: {} }),
      subscribe: storeSubscribe,
    },
  };
});

vi.mock('@/lib/notification-service', () => ({
  getNotificationPermissionStatus: vi.fn(async () => ({ granted: true })),
  startMobileNotifications: vi.fn(async () => undefined),
  stopMobileNotifications: vi.fn(async () => undefined),
}));

vi.mock('@/lib/calendar-push-sync', () => ({
  getCalendarPushEnabled,
  runFullCalendarSync: vi.fn(async () => undefined),
  startCalendarPushSync: vi.fn(() => vi.fn()),
  stopCalendarPushSync: vi.fn(),
}));

vi.mock('@/lib/sync-service', () => ({
  abortMobileSync,
  performMobileSync,
}));

vi.mock('@/lib/background-sync-task', () => ({
  syncMobileBackgroundSyncRegistration,
}));

vi.mock('@/lib/sync-service-utils', () => ({
  classifySyncFailure: vi.fn(() => 'generic'),
  coerceSupportedBackend: vi.fn((backend: string) => backend),
  isLikelyOfflineSyncError: vi.fn(() => false),
  resolveBackend: vi.fn((backend: string | null) => backend ?? 'off'),
}));

vi.mock('@/lib/cloudkit-sync', () => ({
  isCloudKitAvailable: vi.fn(() => false),
  subscribeToCloudKitChanges,
}));

vi.mock('@/lib/widget-service', () => ({
  updateMobileWidgetFromStore,
}));

vi.mock('@/lib/app-log', () => ({
  logError: vi.fn(async () => undefined),
  logInfo: vi.fn(async () => undefined),
  logWarn: vi.fn(async () => undefined),
}));

function TestHarness({ disabled = false }: { disabled?: boolean }) {
  useRootLayoutSyncEffects({
    disabled,
    resolveText: (_key, fallback) => fallback,
    openNotificationsSettings: vi.fn(),
    openSyncSettings: vi.fn(),
    showToast: vi.fn(),
  });
  return null;
}

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('useRootLayoutSyncEffects', () => {
  beforeEach(() => {
    abortMobileSync.mockClear();
    appState.currentState = 'active';
    appStateListeners.clear();
    asyncStorageGetItem.mockClear();
    asyncStorageGetItem.mockResolvedValue('cloud');
    getInMemorySyncChangeFingerprint.mockClear();
    getInMemorySyncChangeFingerprint.mockReturnValue('sync-change:initial');
    flushPendingSave.mockClear();
    getCalendarPushEnabled.mockClear();
    getCalendarPushEnabled.mockResolvedValue(false);
    hasActiveMobileNotificationFeature.mockClear();
    hasActiveMobileNotificationFeature.mockReturnValue(false);
    performMobileSync.mockClear();
    performMobileSync.mockResolvedValue({ success: true });
    storeSubscribe.mockClear();
    storeSubscribe.mockReturnValue(vi.fn());
    syncMobileBackgroundSyncRegistration.mockClear();
    syncMobileBackgroundSyncRegistration.mockResolvedValue(undefined);
    subscribeToCloudKitChanges.mockClear();
    subscribeToCloudKitChanges.mockReturnValue(vi.fn());
    updateMobileWidgetFromStore.mockClear();
    updateMobileWidgetFromStore.mockResolvedValue(true);
  });

  it('does not initialize personal sync, calendar, notification, widget, or app-state services when disabled', async () => {
    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TestHarness disabled />);
      await flushMicrotasks();
    });

    expect(asyncStorageGetItem).not.toHaveBeenCalled();
    expect(storeSubscribe).not.toHaveBeenCalled();
    expect(syncMobileBackgroundSyncRegistration).not.toHaveBeenCalled();
    expect(subscribeToCloudKitChanges).not.toHaveBeenCalled();
    expect(getCalendarPushEnabled).not.toHaveBeenCalled();
    expect(updateMobileWidgetFromStore).not.toHaveBeenCalled();
    expect(appStateListeners.size).toBe(0);

    await act(async () => tree.unmount());
  });

  it('aborts the in-flight mobile sync through the AppState background transition', async () => {
    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TestHarness />);
      await flushMicrotasks();
    });

    const listener = Array.from(appStateListeners)[0];
    expect(listener).toBeTypeOf('function');

    await act(async () => {
      listener('background');
      await flushMicrotasks();
    });

    expect(abortMobileSync).toHaveBeenCalledTimes(1);
    expect(syncMobileBackgroundSyncRegistration).toHaveBeenCalled();
    expect(performMobileSync).toHaveBeenCalled();

    await act(async () => {
      tree.unmount();
    });
  });

  it('does not auto-sync for local-only store changes that leave the sync payload unchanged', async () => {
    vi.useFakeTimers();
    const storeListeners: Array<(state: { lastDataChangeAt: number }, prevState: { lastDataChangeAt: number }) => void> = [];
    storeSubscribe.mockImplementation((...args: unknown[]) => {
      const callback = args[0] as (state: { lastDataChangeAt: number }, prevState: { lastDataChangeAt: number }) => void;
      storeListeners.push(callback);
      return vi.fn();
    });

    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TestHarness />);
      await flushMicrotasks();
    });
    performMobileSync.mockClear();
    const storeListener = storeListeners.find((callback) => callback.length >= 2);
    expect(storeListener).toBeTypeOf('function');

    await act(async () => {
      storeListener?.({ lastDataChangeAt: 2 }, { lastDataChangeAt: 1 });
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();
    });

    expect(performMobileSync).not.toHaveBeenCalled();

    await act(async () => {
      tree.unmount();
    });
    vi.useRealTimers();
  });

  it('skips auto-sync when the change fingerprint is unchanged (device-local sync bookkeeping)', async () => {
    vi.useFakeTimers();
    const storeListeners: Array<(state: { lastDataChangeAt: number }, prevState: { lastDataChangeAt: number }) => void> = [];
    storeSubscribe.mockImplementation((...args: unknown[]) => {
      const callback = args[0] as (state: { lastDataChangeAt: number }, prevState: { lastDataChangeAt: number }) => void;
      storeListeners.push(callback);
      return vi.fn();
    });


    getInMemorySyncChangeFingerprint.mockReturnValue('sync-change:stable');

    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TestHarness />);
      await flushMicrotasks();
    });
    performMobileSync.mockClear();
    const storeListener = storeListeners.find((callback) => callback.length >= 2);
    expect(storeListener).toBeTypeOf('function');

    await act(async () => {
      storeListener?.({ lastDataChangeAt: 2 }, { lastDataChangeAt: 1 });
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();
    });

    expect(performMobileSync).not.toHaveBeenCalled();
    expect(getInMemorySyncChangeFingerprint).toHaveBeenCalled();

    await act(async () => {
      tree.unmount();
    });
    vi.useRealTimers();
  });

  it('defers the payload fingerprint to the debounce timer instead of the write path (#766)', async () => {
    vi.useFakeTimers();
    const storeListeners: Array<(state: { lastDataChangeAt: number }, prevState: { lastDataChangeAt: number }) => void> = [];
    storeSubscribe.mockImplementation((...args: unknown[]) => {
      const callback = args[0] as (state: { lastDataChangeAt: number }, prevState: { lastDataChangeAt: number }) => void;
      storeListeners.push(callback);
      return vi.fn();
    });

    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TestHarness />);
      await flushMicrotasks();
    });
    getInMemorySyncChangeFingerprint.mockClear();
    const storeListener = storeListeners.find((callback) => callback.length >= 2);
    expect(storeListener).toBeTypeOf('function');


    await act(async () => {
      storeListener?.({ lastDataChangeAt: 2 }, { lastDataChangeAt: 1 });
      storeListener?.({ lastDataChangeAt: 3 }, { lastDataChangeAt: 2 });
    });
    expect(getInMemorySyncChangeFingerprint).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();
    });
    expect(getInMemorySyncChangeFingerprint).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree.unmount();
    });
    vi.useRealTimers();
  });

  it('auto-syncs when the sync payload fingerprint changes', async () => {
    vi.useFakeTimers();
    const storeListeners: Array<(state: { lastDataChangeAt: number }, prevState: { lastDataChangeAt: number }) => void> = [];
    storeSubscribe.mockImplementation((...args: unknown[]) => {
      const callback = args[0] as (state: { lastDataChangeAt: number }, prevState: { lastDataChangeAt: number }) => void;
      storeListeners.push(callback);
      return vi.fn();
    });

    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TestHarness />);
      await flushMicrotasks();
    });
    performMobileSync.mockClear();
    getInMemorySyncChangeFingerprint.mockReturnValue('sync-change:changed');
    const storeListener = storeListeners.find((callback) => callback.length >= 2);
    expect(storeListener).toBeTypeOf('function');

    await act(async () => {
      storeListener?.({ lastDataChangeAt: 2 }, { lastDataChangeAt: 1 });
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();
    });

    expect(performMobileSync).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree.unmount();
    });
    vi.useRealTimers();
  });

  it('dedupes rapid unchanged app-state sync triggers', async () => {
    vi.useFakeTimers();
    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TestHarness />);
      await flushMicrotasks();
    });
    performMobileSync.mockClear();
    const listener = Array.from(appStateListeners)[0];
    expect(listener).toBeTypeOf('function');

    await act(async () => {
      listener('background');
      await flushMicrotasks();
      listener('active');
      await flushMicrotasks();
      listener('background');
      await flushMicrotasks();
      listener('active');
      await flushMicrotasks();
    });

    expect(performMobileSync).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree.unmount();
    });
    vi.useRealTimers();
  });


  it('holds off app-state sync triggers while a failure cooldown is active', async () => {
    vi.useFakeTimers();
    performMobileSync.mockResolvedValue({
      success: false,
      error: 'CloudKit error: Request Rate Limited [retryAfter=300]',
    });

    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TestHarness />);
      await flushMicrotasks();
    });
    const listener = Array.from(appStateListeners)[0];
    expect(listener).toBeTypeOf('function');

    await act(async () => {
      listener('background');
      await flushMicrotasks();
    });
    const attemptsAfterFailure = performMobileSync.mock.calls.length;
    expect(attemptsAfterFailure).toBeGreaterThan(0);


    await act(async () => {
      listener('active');
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(500);
      listener('background');
      await flushMicrotasks();
    });

    expect(performMobileSync).toHaveBeenCalledTimes(attemptsAfterFailure);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(299_499);
      await flushMicrotasks();
    });
    expect(performMobileSync).toHaveBeenCalledTimes(attemptsAfterFailure);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await flushMicrotasks();
    });
    expect(performMobileSync).toHaveBeenCalledTimes(attemptsAfterFailure + 1);

    await act(async () => {
      tree.unmount();
    });
    vi.useRealTimers();
  });

  it('retries automatically at the grown failure cooldown without another trigger (#948)', async () => {
    vi.useFakeTimers();
    performMobileSync.mockResolvedValue({
      success: false,
      error: 'CloudKit error: Request Rate Limited [retryAfter=1]',
    });

    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TestHarness />);
      await flushMicrotasks();
    });
    const listener = Array.from(appStateListeners)[0];
    expect(listener).toBeTypeOf('function');

    await act(async () => {
      listener('background');
      await flushMicrotasks();
    });
    expect(performMobileSync).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
      await flushMicrotasks();
    });
    expect(performMobileSync).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await flushMicrotasks();
    });
    expect(performMobileSync).toHaveBeenCalledTimes(2);


    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
      await flushMicrotasks();
    });
    expect(performMobileSync).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await flushMicrotasks();
    });
    expect(performMobileSync).toHaveBeenCalledTimes(3);

    await act(async () => {
      tree.unmount();
    });
    vi.useRealTimers();
  });

  it('cancels the automatic retry when a manual sync reports recovery (#948)', async () => {
    vi.useFakeTimers();
    type SyncStoreSnapshot = {
      lastDataChangeAt: number;
      settings: {
        lastSyncAt?: string;
        lastSyncStatus?: 'success' | 'error' | 'conflict';
      };
    };
    const storeListeners: ((state: SyncStoreSnapshot, prevState: SyncStoreSnapshot) => void)[] = [];
    storeSubscribe.mockImplementation((...args: unknown[]) => {
      const callback = args[0] as (state: SyncStoreSnapshot, prevState: SyncStoreSnapshot) => void;
      storeListeners.push(callback);
      return vi.fn();
    });
    performMobileSync.mockResolvedValue({
      success: false,
      error: 'CloudKit error: Request Rate Limited [retryAfter=300]',
    });

    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TestHarness />);
      await flushMicrotasks();
    });
    const appStateListener = Array.from(appStateListeners)[0];
    const storeListener = storeListeners.find((callback) => callback.length >= 2);
    expect(appStateListener).toBeTypeOf('function');
    expect(storeListener).toBeTypeOf('function');

    await act(async () => {
      appStateListener('background');
      await flushMicrotasks();
    });
    expect(performMobileSync).toHaveBeenCalledTimes(1);


    await act(async () => {
      storeListener?.(
        {
          lastDataChangeAt: 1,
          settings: {
            lastSyncAt: '2026-07-30T12:01:00.000Z',
            lastSyncStatus: 'success',
          },
        },
        {
          lastDataChangeAt: 1,
          settings: {
            lastSyncAt: '2026-07-30T12:00:00.000Z',
            lastSyncStatus: 'error',
          },
        },
      );
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(300_000);
      await flushMicrotasks();
    });

    expect(performMobileSync).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree.unmount();
    });
    vi.useRealTimers();
  });

  it('skips the payload fingerprint entirely when lastDataChangeAt is unchanged', async () => {
    const storeListeners: Array<(state: { lastDataChangeAt: number }, prevState: { lastDataChangeAt: number }) => void> = [];
    storeSubscribe.mockImplementation((...args: unknown[]) => {
      const callback = args[0] as (state: { lastDataChangeAt: number }, prevState: { lastDataChangeAt: number }) => void;
      storeListeners.push(callback);
      return vi.fn();
    });

    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TestHarness />);
      await flushMicrotasks();
    });
    getInMemorySyncChangeFingerprint.mockClear();
    const storeListener = storeListeners.find((callback) => callback.length >= 2);
    expect(storeListener).toBeTypeOf('function');

    await act(async () => {
      storeListener?.({ lastDataChangeAt: 1 }, { lastDataChangeAt: 1 });
      await flushMicrotasks();
    });

    expect(getInMemorySyncChangeFingerprint).not.toHaveBeenCalled();

    await act(async () => {
      tree.unmount();
    });
  });

  it('stretches the auto-sync interval to min(9x cycle duration, 5 min) after a slow sync cycle', async () => {
    vi.useFakeTimers();
    const storeListeners: Array<(state: { lastDataChangeAt: number }, prevState: { lastDataChangeAt: number }) => void> = [];
    storeSubscribe.mockImplementation((...args: unknown[]) => {
      const callback = args[0] as (state: { lastDataChangeAt: number }, prevState: { lastDataChangeAt: number }) => void;
      storeListeners.push(callback);
      return vi.fn();
    });
    let fingerprintVersion = 0;
    getInMemorySyncChangeFingerprint.mockImplementation(() => `sync-change:${fingerprintVersion}`);


    performMobileSync.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 20_000)),
    );

    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TestHarness />);
      await flushMicrotasks();
    });
    performMobileSync.mockClear();
    const storeListener = storeListeners.find((callback) => callback.length >= 2);
    expect(storeListener).toBeTypeOf('function');

    await act(async () => {
      fingerprintVersion += 1;
      storeListener?.({ lastDataChangeAt: 2 }, { lastDataChangeAt: 1 });

      await vi.advanceTimersByTimeAsync(26_000);
      await flushMicrotasks();
    });
    expect(performMobileSync).toHaveBeenCalledTimes(1);

    await act(async () => {
      fingerprintVersion += 1;
      storeListener?.({ lastDataChangeAt: 3 }, { lastDataChangeAt: 2 });


      await vi.advanceTimersByTimeAsync(170_000);
      await flushMicrotasks();
    });
    expect(performMobileSync).toHaveBeenCalledTimes(1);

    await act(async () => {

      await vi.advanceTimersByTimeAsync(40_000);
      await flushMicrotasks();
    });
    expect(performMobileSync).toHaveBeenCalledTimes(2);

    await act(async () => {
      tree.unmount();
    });
    vi.useRealTimers();
  });


  it('syncs on resume for a request that arrived during an active-started cycle', async () => {
    vi.useFakeTimers();
    let resolveSync: ((result: { success: boolean }) => void) | null = null;
    performMobileSync.mockImplementation(() => new Promise((resolve) => {
      resolveSync = resolve;
    }));

    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TestHarness />);
      await flushMicrotasks();
    });
    const listener = Array.from(appStateListeners)[0];
    const cloudKitListener = subscribeToCloudKitChanges.mock.calls[0]?.[0];
    expect(listener).toBeTypeOf('function');
    expect(cloudKitListener).toBeTypeOf('function');


    await act(async () => {
      listener('background');
      await flushMicrotasks();
    });
    expect(performMobileSync).toHaveBeenCalledTimes(1);


    await act(async () => {
      cloudKitListener?.();
      await flushMicrotasks();
      resolveSync?.({ success: true });
      await flushMicrotasks();
    });
    expect(performMobileSync).toHaveBeenCalledTimes(1);

    await act(async () => {
      listener('active');
      await flushMicrotasks();
    });

    expect(performMobileSync).toHaveBeenCalledTimes(2);

    await act(async () => {
      tree.unmount();
    });
    vi.useRealTimers();
  });

  it('runs the denied-permission cleanup when Android notification permission is found denied on resume', async () => {
    vi.useFakeTimers();
    hasActiveMobileNotificationFeature.mockReturnValue(true);
    vi.mocked(getNotificationPermissionStatus).mockResolvedValue({ granted: false, canAskAgain: false });
    vi.mocked(stopMobileNotifications).mockClear();
    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TestHarness />);
      await flushMicrotasks();
    });
    const listener = Array.from(appStateListeners)[0];
    await act(async () => {
      listener('background');
      await flushMicrotasks();
      listener('active');
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(stopMobileNotifications).toHaveBeenCalledTimes(1);
    expect(stopMobileNotifications).toHaveBeenCalledWith({ permissionDenied: true });

    await act(async () => {
      tree.unmount();
    });
    vi.mocked(getNotificationPermissionStatus).mockResolvedValue({ granted: true, canAskAgain: true });
    vi.useRealTimers();
  });

  it('does not queue duplicate foreground syncs for repeated active AppState events', async () => {
    vi.useFakeTimers();
    let tree: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<TestHarness />);
      await flushMicrotasks();
    });
    performMobileSync.mockClear();
    const listener = Array.from(appStateListeners)[0];
    expect(listener).toBeTypeOf('function');

    await act(async () => {
      listener('background');
      await flushMicrotasks();
      listener('active');
      listener('active');
      await vi.advanceTimersByTimeAsync(45_000);
      await flushMicrotasks();
    });

    expect(performMobileSync).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree.unmount();
    });
    vi.useRealTimers();
  });
});
