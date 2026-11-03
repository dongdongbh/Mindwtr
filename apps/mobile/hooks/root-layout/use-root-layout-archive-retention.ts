import { useEffect } from 'react';
import { AppState } from 'react-native';
import { isArchiveRetentionDays, useTaskStore } from '@mindwtr/core';
import { logError } from '@/lib/app-log';
import { getMobileSelectedSyncBackend } from '@/lib/sync-service';

export function useRootLayoutArchiveRetention(canonicalDataReady: boolean, disabled: boolean) {
    const days = useTaskStore((state) => {
        const value = state.settings.gtd?.archiveRetentionDays;
        return isArchiveRetentionDays(value) ? value : 0;
    });
    useEffect(() => {
        if (!canonicalDataReady || disabled || days <= 0) return;
        let running = false;
        const run = () => {
            const state = useTaskStore.getState();
            if (running || AppState.currentState === 'background' || AppState.currentState === 'inactive'
                || state.isLoading || state.error || state.editLockCount > 0) return;
            running = true;


            void getMobileSelectedSyncBackend().then((backend) => backend !== 'off', () => true)
                .then((syncConfigured) => useTaskStore.getState().runArchiveRetention({ syncConfigured }))
                .then((result) => {
                    if (!result.success) void logError(new Error(result.error ?? 'Archive retention failed'), { scope: 'app' });
                })
                .catch((error) => void logError(error, { scope: 'app' }))
                .finally(() => { running = false; });
        };
        run();
        const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') run(); });
        const timer = setInterval(run, 15 * 60 * 1000);
        return () => { subscription.remove(); clearInterval(timer); };
    }, [canonicalDataReady, days, disabled]);
}
