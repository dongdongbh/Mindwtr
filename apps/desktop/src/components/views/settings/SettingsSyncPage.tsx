import { SyncConfigurationSection } from './sync/SyncConfigurationSection';
import { SyncStatusSection } from './sync/SyncStatusSection';
import type { SettingsSyncPageProps } from './sync/types';
import { isValidHttpUrl } from './sync/sync-page-utils';

export function SettingsSyncPage(props: SettingsSyncPageProps) {
    const {
        cloudProvider,
        cloudUrl,
        syncBackend,
        syncPath,
        webdavUrl,
    } = props;

    const isMacOS = typeof navigator !== 'undefined'
        && /mac/i.test(`${navigator.platform || ''} ${navigator.userAgent || ''}`);
    const webdavUrlError = webdavUrl.trim() ? !isValidHttpUrl(webdavUrl.trim()) : false;
    const cloudUrlError = cloudUrl.trim() ? !isValidHttpUrl(cloudUrl.trim()) : false;
    const isSyncTargetValid =
        syncBackend === 'file'
            ? !!syncPath.trim()
            : syncBackend === 'cloudkit'
                ? true
                : syncBackend === 'webdav'
                    ? !!webdavUrl.trim() && !webdavUrlError
                    : syncBackend === 'cloud'
                        ? (cloudProvider === 'selfhosted'
                            ? !!cloudUrl.trim() && !cloudUrlError
                            : props.dropboxConfigured && !!props.dropboxAppKey.trim() && props.dropboxConnected)
                        : false;

    return (
        <div className="space-y-8">
            <SyncConfigurationSection
                {...props}
                isMacOS={isMacOS}
                webdavUrlError={webdavUrlError}
                cloudUrlError={cloudUrlError}
            />
            <SyncStatusSection
                t={props.t}
                syncPreferences={props.syncPreferences}
                onUpdateSyncPreferences={props.onUpdateSyncPreferences}
                isSyncTargetValid={isSyncTargetValid}
                onSyncNow={props.onSyncNow}
                isSyncing={props.isSyncing}
                syncQueued={props.syncQueued}
                syncLastResult={props.syncLastResult}
                syncLastResultAt={props.syncLastResultAt}
                syncError={props.syncError}
                lastSyncDisplay={props.lastSyncDisplay}
                lastSyncStatus={props.lastSyncStatus}
                lastSyncStats={props.lastSyncStats}
                lastSyncHistory={props.lastSyncHistory}
                conflictCount={props.conflictCount}
                lastSyncError={props.lastSyncError}
                snapshots={props.snapshots}
                isLoadingSnapshots={props.isLoadingSnapshots}
                isRestoringSnapshot={props.isRestoringSnapshot}
                onRestoreSnapshot={props.onRestoreSnapshot}
            />
        </div>
    );
}
