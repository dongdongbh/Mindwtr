import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useManualPullSync } from './use-manual-pull-sync';

const mocked = vi.hoisted(() => ({
  getMobileSyncActivityState: vi.fn(() => 'idle'),
  getMobileSyncConfigurationStatus: vi.fn(),
  getSyncConflictCount: vi.fn(() => 0),
  isLikelyOfflineSyncError: vi.fn(() => false),
  performMobileSync: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('@/contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string) =>
      ({
        'common.notice': 'Notice',
        'common.offline': 'Offline',
        'settings.lastSyncError': 'Sync failed',
        'settings.syncCompletedWithConflicts': 'Sync completed with {count} conflicts (resolved automatically).',
        'settings.syncMobile.pleaseSetAWebdavUrlFirst': 'Please set a WebDAV URL first',
        'settings.syncQueued': 'Sync queued',
        'settings.syncQueuedBody': 'Local changes arrived during sync. A retry was queued automatically.',
        'settings.syncRemoteBusy': 'Another compatible Mindwtr device is updating this sync location. Wait for it to finish, then sync again.',
        'settings.syncRemoteCleanupDeferred': 'The sync operation completed. Mindwtr could not remove the temporary sync lock, but it expires automatically. No retry is needed.',
        'settings.syncSkippedOffline': 'No internet connection. Sync skipped.',
        'settings.syncServerUnreachable': "Couldn't reach the sync server. Check that Mindwtr is allowed to use the network (cellular data, VPN, or firewall).",
      }[key] ?? key),
  }),
}));

vi.mock('@/contexts/toast-context', () => ({
  ToastViewport: () => null,
  useToast: () => ({
    showToast: mocked.showToast,
    dismissToast: vi.fn(),
  }),
}));

vi.mock('@/lib/sync-service', () => ({
  getMobileSyncActivityState: mocked.getMobileSyncActivityState,
  getMobileSyncConfigurationStatus: mocked.getMobileSyncConfigurationStatus,
  performMobileSync: mocked.performMobileSync,
}));

vi.mock('@/lib/sync-service-utils', () => ({
  getSyncConflictCount: mocked.getSyncConflictCount,
  isLikelyOfflineSyncError: mocked.isLikelyOfflineSyncError,
}));

let latest: ReturnType<typeof useManualPullSync> | null = null;
let tree: ReactTestRenderer | null = null;

function Harness() {
  latest = useManualPullSync();
  return React.createElement('ManualPullSyncHarness', {
    indicatorState: latest.indicatorState,
    refreshing: latest.refreshing,
  });
}

const renderHarness = () => {
  act(() => {
    tree = create(<Harness />);
  });
};

describe('useManualPullSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    latest = null;
    mocked.getMobileSyncConfigurationStatus.mockReset();
    mocked.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'webdav', configured: true });
    mocked.getSyncConflictCount.mockReset();
    mocked.getSyncConflictCount.mockReturnValue(0);
    mocked.isLikelyOfflineSyncError.mockReset();
    mocked.isLikelyOfflineSyncError.mockReturnValue(false);
    mocked.performMobileSync.mockReset();
    mocked.performMobileSync.mockResolvedValue({ success: true });
    mocked.getMobileSyncActivityState.mockReset();
    mocked.getMobileSyncActivityState.mockReturnValue('idle');
    mocked.showToast.mockReset();
  });

  afterEach(() => {
    if (tree) {
      act(() => {
        tree?.unmount();
      });
    }
    tree = null;
    vi.useRealTimers();
  });

  it('runs configured sync and settles the manual indicator without a success toast', async () => {
    renderHarness();

    await act(async () => {
      await latest?.onRefresh();
    });

    expect(mocked.performMobileSync).toHaveBeenCalledTimes(1);
    expect(mocked.performMobileSync).toHaveBeenCalledWith(undefined, { manual: true });
    expect(latest?.indicatorState).toBe('success');
    expect(latest?.refreshing).toBe(false);
    expect(mocked.showToast).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(900);
    });

    expect(latest?.indicatorState).toBe('idle');
  });

  it('shows setup feedback without calling sync when the backend is not configured', async () => {
    mocked.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'webdav', configured: false });
    renderHarness();

    await act(async () => {
      await latest?.onRefresh();
    });

    expect(mocked.performMobileSync).not.toHaveBeenCalled();
    expect(latest?.indicatorState).toBe('error');
    expect(mocked.showToast).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Please set a WebDAV URL first',
      tone: 'warning',
    }));
  });

  it('joins an in-flight activation sync instead of toasting setup advice', async () => {
    mocked.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'off', configured: false });
    mocked.getMobileSyncActivityState.mockReturnValue('syncing');
    renderHarness();

    await act(async () => {
      await latest?.onRefresh();
    });

    expect(mocked.performMobileSync).toHaveBeenCalledTimes(1);
    expect(latest?.indicatorState).toBe('success');
    expect(mocked.showToast).not.toHaveBeenCalled();
  });

  it('asks the user to set up sync, not a sync folder, when sync is off', async () => {
    mocked.getMobileSyncConfigurationStatus.mockResolvedValue({ backend: 'off', configured: false });
    renderHarness();

    await act(async () => {
      await latest?.onRefresh();
    });

    expect(mocked.performMobileSync).not.toHaveBeenCalled();
    expect(mocked.showToast).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Please set up sync first',
      tone: 'warning',
    }));
  });

  it('asks for a Dropbox connection when the cloud provider is Dropbox', async () => {
    mocked.getMobileSyncConfigurationStatus.mockResolvedValue({
      backend: 'cloud',
      cloudProvider: 'dropbox',
      configured: false,
    });
    renderHarness();

    await act(async () => {
      await latest?.onRefresh();
    });

    expect(mocked.performMobileSync).not.toHaveBeenCalled();
    expect(mocked.showToast).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Please connect Dropbox first.',
      tone: 'warning',
    }));
  });

  it('surfaces offline skips as manual pull errors', async () => {
    mocked.performMobileSync.mockResolvedValue({ success: true, skipped: 'offline' });
    renderHarness();

    await act(async () => {
      await latest?.onRefresh();
    });

    expect(latest?.indicatorState).toBe('error');
    expect(mocked.showToast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Offline',
      message: 'No internet connection. Sync skipped.',
      tone: 'warning',
    }));
  });

  it('reports an unreachable sync server instead of claiming the device is offline', async () => {
    mocked.performMobileSync.mockResolvedValue({ success: true, skipped: 'offline', offlineCause: 'request' });
    renderHarness();

    await act(async () => {
      await latest?.onRefresh();
    });

    expect(latest?.indicatorState).toBe('error');
    expect(mocked.showToast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Notice',
      message: "Couldn't reach the sync server. Check that Mindwtr is allowed to use the network (cellular data, VPN, or firewall).",
      tone: 'warning',
    }));
  });

  it('surfaces a deferred remote write as an error even though success is true', async () => {
    mocked.performMobileSync.mockResolvedValue({
      success: true,
      remoteWriteDeferred: true,
      error: 'Remote write failed. Retrying in the background.',
    });
    renderHarness();

    await act(async () => {
      await latest?.onRefresh();
    });

    expect(latest?.indicatorState).toBe('error');
    expect(mocked.showToast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Sync failed',
      message: 'Remote write failed. Retrying in the background.',
      tone: 'error',
    }));
  });

  it.each([
    {
      deferred: 'busy' as const,
      message: 'Another compatible Mindwtr device is updating this sync location. Wait for it to finish, then sync again.',
    },
    {
      deferred: 'cleanup' as const,
      message: 'The sync operation completed. Mindwtr could not remove the temporary sync lock, but it expires automatically. No retry is needed.',
    },
  ])('explains a $deferred remote fence without blaming local edits', async ({ deferred, message }) => {
    mocked.performMobileSync.mockResolvedValue({
      success: true,
      remoteFenceDeferred: deferred,
    });
    renderHarness();

    await act(async () => {
      await latest?.onRefresh();
    });

    expect(latest?.indicatorState).toBe('success');
    expect(mocked.showToast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Notice',
      message,
      tone: 'info',
    }));
    expect(mocked.showToast).not.toHaveBeenCalledWith(expect.objectContaining({
      message: 'Local changes arrived during sync. A retry was queued automatically.',
    }));
  });

  it('keeps success quiet except for conflict summaries', async () => {
    mocked.getSyncConflictCount.mockReturnValue(2);
    mocked.performMobileSync.mockResolvedValue({ success: true, stats: {} });
    renderHarness();

    await act(async () => {
      await latest?.onRefresh();
    });

    expect(latest?.indicatorState).toBe('success');
    expect(mocked.showToast).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Sync completed with 2 conflicts (resolved automatically).',
      tone: 'warning',
    }));
  });
});
