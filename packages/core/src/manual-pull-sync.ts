


import { tFallback } from './i18n';
import type { MobileSyncService } from './mobile-sync-service';


export type ManualPullSyncIndicator = 'success' | 'error' | 'idle';
export type ManualPullSyncToast = { title: string; message: string; tone: 'warning' | 'info' | 'error'; durationMs?: number };
export type ManualPullSyncOutcome = { indicator: ManualPullSyncIndicator; toast: ManualPullSyncToast | null };

type SyncResult = Awaited<ReturnType<MobileSyncService['performMobileSync']>>;
type ConfigurationStatus = Awaited<ReturnType<MobileSyncService['getMobileSyncConfigurationStatus']>>;

export type ManualPullSyncDeps = {
    getConfigurationStatus: () => Promise<Pick<ConfigurationStatus, 'configured' | 'backend' | 'cloudProvider'>>;
    getActivityState: () => string;

    performSync: () => Promise<SyncResult>;
    isLikelyOfflineSyncError: (error: unknown) => boolean;
    getSyncConflictCount: (stats: SyncResult['stats']) => number;
    t: (key: string) => string;
};

const formatCountTemplate = (template: string, count: number) => (
    template
        .replace(/\{\{\s*count\s*\}\}/g, String(count))
        .replace(/\{\s*count\s*\}/g, String(count))
);

const getSetupMessage = (backend: string, cloudProvider: string | undefined, t: (key: string) => string) => {
    if (backend === 'file') return tFallback(t, 'settings.syncMobile.pleaseSetASyncFolderFirst', 'Please set a sync folder first');
    if (backend === 'webdav') return tFallback(t, 'settings.syncMobile.pleaseSetAWebdavUrlFirst', 'Please set a WebDAV URL first');
    if (backend === 'cloudkit') return tFallback(t, 'settings.syncMobile.icloudUnavailable', 'iCloud unavailable');
    if (backend === 'cloud') {
        if (cloudProvider === 'dropbox') return tFallback(t, 'settings.syncMobile.pleaseConnectDropboxFirst', 'Please connect Dropbox first.');
        return tFallback(t, 'settings.syncMobile.pleaseSetASelfHostedUrlFirst', 'Please set a self-hosted URL first');
    }
    return tFallback(t, 'settings.syncMobile.pleaseSetUpSyncFirst', 'Please set up sync first');
};

const getErrorMessage = (error: unknown) => {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string' && error.trim().length > 0) return error.trim();
    return 'Sync failed';
};


export async function runManualPullSync(deps: ManualPullSyncDeps): Promise<ManualPullSyncOutcome> {
    const { t } = deps;
    try {
        const status = await deps.getConfigurationStatus();


        if ((!status.configured || status.backend === 'off') && deps.getActivityState() !== 'syncing') {
            return { indicator: 'error', toast: {
                title: tFallback(t, 'common.notice', 'Notice'),
                message: getSetupMessage(status.backend, status.cloudProvider, t),
                tone: 'warning',
                durationMs: 3600,
            } };
        }

        const result = await deps.performSync();
        if (result.skipped === 'offline' || deps.isLikelyOfflineSyncError(result.error)) {


            const serverUnreachable = result.skipped === 'offline' && result.offlineCause === 'request';
            return { indicator: 'error', toast: {
                title: serverUnreachable
                    ? tFallback(t, 'common.notice', 'Notice')
                    : tFallback(t, 'common.offline', 'Offline'),
                message: serverUnreachable
                    ? tFallback(t, 'settings.syncServerUnreachable', "Couldn't reach the sync server. Check that Mindwtr is allowed to use the network (cellular data, VPN, or firewall).")
                    : tFallback(t, 'settings.syncSkippedOffline', 'No internet connection. Sync skipped.'),
                tone: 'warning',
            } };
        }

        if (result.skipped === 'requeued') {
            return { indicator: 'success', toast: {
                title: tFallback(t, 'settings.syncQueued', 'Sync queued'),
                message: tFallback(t, 'settings.syncQueuedBody', 'Local changes arrived during sync. A retry was queued automatically.'),
                tone: 'info',
                durationMs: 4200,
            } };
        }

        if (result.success && !result.remoteWriteDeferred && result.fileAttachmentUploadBlocked === 'too-large') {
            return { indicator: 'idle', toast: {
                title: tFallback(t, 'common.notice', 'Notice'),
                message: tFallback(
                    t,
                    'settings.syncFileAttachmentTooLarge',
                    'Mindwtr kept the local attachment. File Sync can only sync attachments under 100 MB. Replace it with a smaller file or remove the attachment, then sync again.'
                ),
                tone: 'warning',
                durationMs: 6000,
            } };
        }

        if (result.remoteWriteDeferred) {
            throw new Error(result.error || tFallback(t, 'settings.lastSyncError', 'Sync failed'));
        }

        if (result.success && result.attachmentWriteDeferred) {
            return { indicator: 'idle', toast: {
                title: tFallback(t, 'common.notice', 'Notice'),
                message: tFallback(
                    t,
                    'settings.syncAttachmentWriteDeferred',
                    'Some attachment changes could not finish. Restore any missing local files or remove the affected attachments, then sync again.'
                ),
                tone: 'warning',
                durationMs: 6000,
            } };
        }

        if (result.success && result.fileSyncLockDeferred) {
            const cleanupDeferred = result.fileSyncLockDeferred === 'cleanup';
            return { indicator: cleanupDeferred ? 'success' : 'idle', toast: {
                title: tFallback(t, 'common.notice', 'Notice'),
                message: cleanupDeferred
                    ? tFallback(
                        t,
                        'settings.syncFileLockCleanupDeferred',
                        'Sync completed, but Mindwtr could not release the File Sync lock. Restart Mindwtr before syncing again. No retry is needed.'
                    )
                    : tFallback(
                        t,
                        'settings.syncFileLockBusy',
                        'Another Mindwtr operation is using File Sync. Wait for it to finish; Mindwtr will retry automatically.'
                    ),
                tone: 'info',
                durationMs: 6000,
            } };
        }

        if (result.fileSyncLockUnavailable) {
            return { indicator: 'error', toast: {
                title: tFallback(t, 'settings.lastSyncError', 'Sync failed'),
                message: tFallback(
                    t,
                    'settings.syncFileLockUnavailable',
                    'Mindwtr cannot safely lock this File Sync location. Re-select the folder, restart or update Mindwtr, or use WebDAV.'
                ),
                tone: 'error',
                durationMs: 6000,
            } };
        }

        if (result.success && result.remoteFenceDeferred) {
            const cleanupDeferred = result.remoteFenceDeferred === 'cleanup';
            return { indicator: cleanupDeferred ? 'success' : 'idle', toast: {
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
            } };
        }

        if (!result.success) {
            throw new Error(result.error || tFallback(t, 'settings.lastSyncError', 'Sync failed'));
        }

        const conflictCount = deps.getSyncConflictCount(result.stats);
        return { indicator: 'success', toast: conflictCount > 0 ? {
            title: tFallback(t, 'common.notice', 'Notice'),
            message: formatCountTemplate(
                tFallback(t, 'settings.syncCompletedWithConflicts', 'Sync completed with {count} conflicts (resolved automatically).'),
                conflictCount
            ),
            tone: 'warning',
            durationMs: 5200,
        } : null };
    } catch (error) {
        return { indicator: 'error', toast: {
            title: tFallback(t, 'settings.lastSyncError', 'Sync failed'),
            message: getErrorMessage(error),
            tone: 'error',
            durationMs: 5200,
        } };
    }
}
