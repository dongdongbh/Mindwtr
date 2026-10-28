import { useCallback, useEffect, useRef, useState } from 'react';
import { runManualPullSync } from '@mindwtr/core';

import { useLanguage } from '@/contexts/language-context';
import { useToast } from '@/contexts/toast-context';
import { getMobileSyncActivityState, getMobileSyncConfigurationStatus, performMobileSync } from '@/lib/sync-service';
import type { PullSyncIndicatorState } from '@/components/PullSyncIndicator';
import {
  getSyncConflictCount,
  isLikelyOfflineSyncError,
} from '@/lib/sync-service-utils';

const PULL_SYNC_SETTLE_MS = 900;

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

  const finishDeferredIndicator = useCallback(() => {
    clearHideTimer();
    setIndicatorState('idle');
  }, [clearHideTimer]);

  useEffect(() => clearHideTimer, [clearHideTimer]);

  const onRefresh = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    clearHideTimer();
    setIndicatorState('syncing');

    try {
      // Core's rules for one manual pull (manual-pull-sync.ts), shared with the native Android host.
      const outcome = await runManualPullSync({
        getConfigurationStatus: getMobileSyncConfigurationStatus,
        getActivityState: getMobileSyncActivityState,
        performSync: () => performMobileSync(undefined, { manual: true }),
        isLikelyOfflineSyncError,
        getSyncConflictCount,
        t,
      });
      if (outcome.indicator === 'idle') finishDeferredIndicator();
      else finishIndicator(outcome.indicator);
      if (outcome.toast) showToast(outcome.toast);
    } finally {
      runningRef.current = false;
    }
  }, [clearHideTimer, finishDeferredIndicator, finishIndicator, showToast, t]);

  return {
    indicatorState,
    onRefresh,
    refreshing: indicatorState === 'syncing',
  };
}
