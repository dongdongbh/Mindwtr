import { useCallback, useEffect, useRef, useState } from 'react';
import { tFallback } from '@mindwtr/core';

import { useLanguage } from '@/contexts/language-context';
import { useToast } from '@/contexts/toast-context';
import { getMobileSyncActivityState, getMobileSyncConfigurationStatus, performMobileSync } from '@/lib/sync-service';
import type { PullSyncIndicatorState } from '@/components/PullSyncIndicator';
import {
  getSyncConflictCount,
  isLikelyOfflineSyncError,
} from '@/lib/sync-service-utils';

const PULL_SYNC_SETTLE_MS = 900;

type SyncBackendName = 'off' | 'file' | 'webdav' | 'cloud' | 'cloudkit' | string;

const formatCountTemplate = (template: string, count: number) => (
  template
    .replace(/\{\{\s*count\s*\}\}/g, String(count))
    .replace(/\{\s*count\s*\}/g, String(count))
);

const getSetupMessage = (backend: SyncBackendName, cloudProvider: string | undefined, t: (key: string) => string) => {
  if (backend === 'file') {
    return tFallback(t, 'settings.syncMobile.pleaseSetASyncFolderFirst', 'Please set a sync folder first');
  }
  if (backend === 'webdav') {
    return tFallback(t, 'settings.syncMobile.pleaseSetAWebdavUrlFirst', 'Please set a WebDAV URL first');
  }
  if (backend === 'cloudkit') {
    return tFallback(t, 'settings.syncMobile.icloudUnavailable', 'iCloud unavailable');
  }
  if (backend === 'cloud') {
    if (cloudProvider === 'dropbox') {
      return tFallback(t, 'settings.syncMobile.pleaseConnectDropboxFirst', 'Please connect Dropbox first.');
    }
    return tFallback(t, 'settings.syncMobile.pleaseSetASelfHostedUrlFirst', 'Please set a self-hosted URL first');
  }
  return tFallback(t, 'settings.syncMobile.pleaseSetUpSyncFirst', 'Please set up sync first');
};

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string' && error.trim().length > 0) return error.trim();
  return 'Sync failed';
};

export function useManualPullSync() {
  const { t } = useLanguage();
  const { showToast } = useToast();
  const [indicatorState, setIndicatorState] = useState<PullSyncIndicatorState>('idle');
  const runningRef = useRef(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHideTimer = useCallback(() => {
    if (!hideTimerRef.current) return;
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  const finishIndicator = useCallback((state: Exclude<PullSyncIndicatorState, 'idle'>) => {
    clearHideTimer();
    setIndicatorState(state);
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      setIndicatorState('idle');
    }, PULL_SYNC_SETTLE_MS);
  }, [clearHideTimer]);

  useEffect(() => clearHideTimer, [clearHideTimer]);

  const onRefresh = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    clearHideTimer();
    setIndicatorState('syncing');

    try {
      const status = await getMobileSyncConfigurationStatus();
      // The persisted config lags while a sync-settings activation probe is
      // proving new credentials (e.g. the Dropbox OAuth continuation, #1033).
      // If a sync is already running, join it instead of toasting setup advice.
      if ((!status.configured || status.backend === 'off') && getMobileSyncActivityState() !== 'syncing') {
        finishIndicator('error');
        showToast({
          title: tFallback(t, 'common.notice', 'Notice'),
          message: getSetupMessage(status.backend, status.cloudProvider, t),
          tone: 'warning',
          durationMs: 3600,
        });
        return;
      }

      const result = await performMobileSync(undefined, { manual: true });
      if (result.skipped === 'offline' || isLikelyOfflineSyncError(result.error)) {
        finishIndicator('error');
        // 'request' means the OS says the device is online but the app's own
        // requests failed — telling the user they are offline would be false.
        const serverUnreachable = result.skipped === 'offline' && result.offlineCause === 'request';
        showToast({
          title: serverUnreachable
            ? tFallback(t, 'common.notice', 'Notice')
            : tFallback(t, 'common.offline', 'Offline'),
          message: serverUnreachable
            ? tFallback(t, 'settings.syncServerUnreachable', "Couldn't reach the sync server. Check that Mindwtr is allowed to use the network (cellular data, VPN, or firewall).")
            : tFallback(t, 'settings.syncSkippedOffline', 'No internet connection. Sync skipped.'),
          tone: 'warning',
        });
        return;
      }

      if (result.skipped === 'requeued') {
        finishIndicator('success');
        showToast({
          title: tFallback(t, 'settings.syncQueued', 'Sync queued'),
          message: tFallback(
            t,
            'settings.syncQueuedBody',
            'Local changes arrived during sync. A retry was queued automatically.'
          ),
          tone: 'info',
          durationMs: 4200,
        });
        return;
      }

      if (result.success && result.remoteFenceDeferred) {
        finishIndicator('success');
        const cleanupDeferred = result.remoteFenceDeferred === 'cleanup';
        showToast({
          title: tFallback(t, 'common.notice', 'Notice'),
          message: cleanupDeferred
            ? tFallback(
              t,
              'settings.syncRemoteCleanupDeferred',
              'The sync operation completed. Mindwtr could not remove the temporary sync lock, but it expires automatically. No retry is needed.'
            )
            : tFallback(
              t,
              'settings.syncRemoteBusy',
              'Another compatible Mindwtr device is updating this sync location. Wait for it to finish, then sync again.'
            ),
          tone: 'info',
          durationMs: 6000,
        });
        return;
      }

      if (!result.success || result.remoteWriteDeferred) {
        throw new Error(result.error || tFallback(t, 'settings.lastSyncError', 'Sync failed'));
      }

      finishIndicator('success');
      const conflictCount = getSyncConflictCount(result.stats);
      if (conflictCount > 0) {
        showToast({
          title: tFallback(t, 'common.notice', 'Notice'),
          message: formatCountTemplate(
            tFallback(
              t,
              'settings.syncCompletedWithConflicts',
              'Sync completed with {count} conflicts (resolved automatically).'
            ),
            conflictCount
          ),
          tone: 'warning',
          durationMs: 5200,
        });
      }
    } catch (error) {
      finishIndicator('error');
      showToast({
        title: tFallback(t, 'settings.lastSyncError', 'Sync failed'),
        message: getErrorMessage(error),
        tone: 'error',
        durationMs: 5200,
      });
    } finally {
      runningRef.current = false;
    }
  }, [clearHideTimer, finishIndicator, showToast, t]);

  return {
    indicatorState,
    onRefresh,
    refreshing: indicatorState === 'syncing',
  };
}
