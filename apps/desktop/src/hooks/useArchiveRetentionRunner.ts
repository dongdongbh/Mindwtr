import { useEffect } from 'react';
import { isArchiveRetentionDays, useTaskStore } from '@mindwtr/core';
import { logError } from '../lib/app-log';
import { SyncService } from '../lib/sync-service';
import { useUiStore } from '../store/ui-store';

export function useArchiveRetentionRunner(hydrated: boolean, disabled: boolean) {
    const days = useTaskStore((state) => {
        const value = state.settings.gtd?.archiveRetentionDays;
        return isArchiveRetentionDays(value) ? value : 0;
    });
    useEffect(() => {
        if (disabled || !hydrated || days <= 0) return;
        let running = false;
        const run = () => {
            const state = useTaskStore.getState();
            if (running || document.visibilityState === 'hidden' || state.isLoading || state.error
                || state.editLockCount > 0 || useUiStore.getState().editingTaskId !== null) return;
            running = true;


            void SyncService.getPersistedSyncConfigurationSnapshot()
                .then(({ backend }) => backend !== 'off', () => true)
                .then((syncConfigured) => useTaskStore.getState().runArchiveRetention({ syncConfigured }))
                .then((result) => {
                    if (!result.success) void logError(new Error(result.error ?? 'Archive retention failed'), { scope: 'app', step: 'archiveRetention' });
                })
                .catch((error) => void logError(error, { scope: 'app', step: 'archiveRetention' }))
                .finally(() => { running = false; });
        };
        run();
        window.addEventListener('focus', run);
        document.addEventListener('visibilitychange', run);
        const timer = window.setInterval(run, 15 * 60 * 1000);
        return () => {
            window.removeEventListener('focus', run);
            document.removeEventListener('visibilitychange', run);
            window.clearInterval(timer);
        };
    }, [days, disabled, hydrated]);
}
