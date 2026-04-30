import { AlertCircle, CheckCircle2, RefreshCw } from 'lucide-react';
import { cn } from '../../../../lib/utils';
import type { SettingsSyncPageProps } from './types';

type SyncConfigurationSectionProps = Pick<
    SettingsSyncPageProps,
    | 't'
    | 'isTauri'
    | 'syncBackend'
    | 'onSetSyncBackend'
    | 'syncPath'
    | 'onSyncPathChange'
    | 'onSaveSyncPath'
    | 'onBrowseSyncPath'
    | 'webdavUrl'
    | 'webdavUsername'
    | 'webdavPassword'
    | 'webdavHasPassword'
    | 'isSavingWebDav'
    | 'isTestingWebDav'
    | 'webdavTestState'
    | 'onWebdavUrlChange'
    | 'onWebdavUsernameChange'
    | 'onWebdavPasswordChange'
    | 'onSaveWebDav'
    | 'onTestWebDavConnection'
    | 'cloudUrl'
    | 'cloudToken'
    | 'cloudProvider'
    | 'dropboxConfigured'
    | 'dropboxConnected'
    | 'dropboxBusy'
    | 'dropboxAuthInProgress'
    | 'dropboxRedirectUri'
    | 'dropboxTestState'
    | 'onCloudUrlChange'
    | 'onCloudTokenChange'
    | 'onCloudProviderChange'
    | 'onSaveCloud'
    | 'onConnectDropbox'
    | 'onDisconnectDropbox'
    | 'onTestDropboxConnection'
> & {
    isMacOS: boolean;
    webdavUrlError: boolean;
    cloudUrlError: boolean;
};

const BackendButton = ({
    active,
    children,
    onClick,
}: {
    active: boolean;
    children: React.ReactNode;
    onClick: () => void;
}) => (
    <button
        onClick={onClick}
        className={cn(
            'px-3 py-1.5 rounded-md text-sm font-medium transition-colors border',
            active
                ? 'bg-primary/10 text-primary border-primary ring-1 ring-primary'
                : 'bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground',
        )}
    >
        {children}
    </button>
);

const ConnectionBadge = ({
    state,
    successLabel,
    errorLabel,
}: {
    state: 'idle' | 'success' | 'error';
    successLabel: string;
    errorLabel: string;
}) => {
    if (state === 'idle') return null;
    return (
        <span
            className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs',
                state === 'success'
                    ? 'border-emerald-600/40 text-emerald-500'
                    : 'border-destructive/40 text-destructive'
            )}
        >
            {state === 'success'
                ? <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                : <AlertCircle className="w-3.5 h-3.5" aria-hidden="true" />}
            {state === 'success' ? successLabel : errorLabel}
        </span>
    );
};

const renderDropboxPanel = ({
    dropboxBusy,
    dropboxAuthInProgress,
    dropboxConfigured,
    dropboxConnected,
    dropboxRedirectUri,
    dropboxTestState,
    onConnectDropbox,
    onDisconnectDropbox,
    onTestDropboxConnection,
    t,
}: Pick<
    SyncConfigurationSectionProps,
    | 'dropboxBusy'
    | 'dropboxAuthInProgress'
    | 'dropboxConfigured'
    | 'dropboxConnected'
    | 'dropboxRedirectUri'
    | 'dropboxTestState'
    | 'onConnectDropbox'
    | 'onDisconnectDropbox'
    | 'onTestDropboxConnection'
    | 't'
>) => (
    <div className="space-y-3">
        <div className="flex flex-col gap-2">
            <label className="text-sm font-medium">{t.dropboxAppKey}</label>
            <p className="text-xs text-muted-foreground">{t.dropboxAppKeyHint}</p>
            {dropboxAuthInProgress && dropboxRedirectUri.trim() && (
                <p className="text-xs text-muted-foreground">
                    {t.dropboxRedirectUri}: <span className="font-mono break-all">{dropboxRedirectUri}</span>
                </p>
            )}
            {!dropboxConfigured && (
                <p className="text-xs text-destructive">
                    Dropbox app key is not configured in this build.
                </p>
            )}
            <p className="text-xs text-muted-foreground">
                {t.dropboxStatus}: {dropboxConnected ? t.dropboxConnected : t.dropboxNotConnected}
            </p>
        </div>

        <div className="flex flex-wrap justify-end gap-2">
            <button
                onClick={dropboxConnected ? onDisconnectDropbox : onConnectDropbox}
                disabled={dropboxBusy || !dropboxConfigured}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 whitespace-nowrap disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed"
            >
                {dropboxConnected ? t.dropboxDisconnect : t.dropboxConnect}
            </button>
            <button
                onClick={onTestDropboxConnection}
                disabled={dropboxBusy || !dropboxConfigured}
                className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md text-sm font-medium hover:bg-secondary/90 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
            >
                {dropboxBusy ? t.syncing : t.dropboxTest}
            </button>
            <ConnectionBadge
                state={dropboxTestState}
                successLabel={t.dropboxTestReachable}
                errorLabel={t.dropboxTestFailed}
            />
        </div>
    </div>
);

const renderSelfHostedCloudPanel = ({
    cloudToken,
    cloudUrl,
    cloudUrlError,
    onCloudTokenChange,
    onCloudUrlChange,
    onSaveCloud,
    t,
}: Pick<
    SyncConfigurationSectionProps,
    | 'cloudToken'
    | 'cloudUrl'
    | 'onCloudTokenChange'
    | 'onCloudUrlChange'
    | 'onSaveCloud'
    | 't'
> & { cloudUrlError: boolean }) => (
    <div className="space-y-3">
        <div className="flex flex-col gap-2">
            <label className="text-sm font-medium">{t.cloudUrl}</label>
            <input
                type="text"
                value={cloudUrl}
                onChange={(e) => onCloudUrlChange(e.target.value)}
                placeholder="https://example.com"
                className={cn(
                    'bg-muted p-2 rounded text-sm font-mono border focus:outline-none focus:ring-2 focus:ring-primary',
                    cloudUrlError ? 'border-destructive' : 'border-border',
                )}
            />
            <p className="text-xs text-muted-foreground">{t.cloudHint}</p>
            {cloudUrlError && (
                <p className="text-xs text-destructive">Enter a valid http(s) URL.</p>
            )}
        </div>

        <div className="flex flex-col gap-2">
            <label className="text-sm font-medium">{t.cloudToken}</label>
            <input
                type="password"
                value={cloudToken}
                onChange={(e) => onCloudTokenChange(e.target.value)}
                className="bg-muted p-2 rounded text-sm border border-border focus:outline-none focus:ring-2 focus:ring-primary"
            />
        </div>

        <div className="flex justify-end">
            <button
                onClick={onSaveCloud}
                disabled={cloudUrlError}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 whitespace-nowrap disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed"
            >
                {t.cloudSave}
            </button>
        </div>
    </div>
);

const renderWebDavPanel = ({
    isSavingWebDav,
    isTauri,
    isTestingWebDav,
    onSaveWebDav,
    onTestWebDavConnection,
    onWebdavPasswordChange,
    onWebdavUrlChange,
    onWebdavUsernameChange,
    t,
    webdavHasPassword,
    webdavPassword,
    webdavTestState,
    webdavUrl,
    webdavUrlError,
    webdavUsername,
}: Pick<
    SyncConfigurationSectionProps,
    | 'isSavingWebDav'
    | 'isTauri'
    | 'isTestingWebDav'
    | 'onSaveWebDav'
    | 'onTestWebDavConnection'
    | 'onWebdavPasswordChange'
    | 'onWebdavUrlChange'
    | 'onWebdavUsernameChange'
    | 't'
    | 'webdavHasPassword'
    | 'webdavPassword'
    | 'webdavTestState'
    | 'webdavUrl'
    | 'webdavUsername'
> & { webdavUrlError: boolean }) => (
    <div className="space-y-3">
        <div className="flex flex-col gap-2">
            <label className="text-sm font-medium">{t.webdavUrl}</label>
            <input
                type="text"
                value={webdavUrl}
                onChange={(e) => onWebdavUrlChange(e.target.value)}
                placeholder="https://example.com/remote.php/dav/files/user/data.json"
                className={cn(
                    'bg-muted p-2 rounded text-sm font-mono border focus:outline-none focus:ring-2 focus:ring-primary',
                    webdavUrlError ? 'border-destructive' : 'border-border',
                )}
            />
            <p className="text-xs text-muted-foreground">{t.webdavHint}</p>
            {webdavUrlError && (
                <p className="text-xs text-destructive">Enter a valid http(s) URL.</p>
            )}
        </div>

        <div className="grid sm:grid-cols-2 gap-2">
            <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">{t.webdavUsername}</label>
                <input
                    type="text"
                    value={webdavUsername}
                    onChange={(e) => onWebdavUsernameChange(e.target.value)}
                    className="bg-muted p-2 rounded text-sm border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                />
            </div>
            <div className="flex flex-col gap-2">
                <label className="text-sm font-medium">{t.webdavPassword}</label>
                <input
                    type="password"
                    value={webdavPassword}
                    onChange={(e) => onWebdavPasswordChange(e.target.value)}
                    placeholder={webdavHasPassword && !webdavPassword ? '••••••••' : ''}
                    className="bg-muted p-2 rounded text-sm border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                />
            </div>
        </div>
        {!isTauri && (
            <p className="text-xs text-amber-600">
                Web warning: WebDAV passwords are stored in browser storage. Use only on trusted devices.
            </p>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
            <button
                onClick={onTestWebDavConnection}
                disabled={webdavUrlError || !webdavUrl.trim() || isTestingWebDav}
                aria-label={t.webdavTestAccessibility}
                className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md text-sm font-medium hover:bg-secondary/90 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
            >
                {isTestingWebDav ? t.syncing : t.testConnection}
            </button>
            <button
                onClick={onSaveWebDav}
                disabled={webdavUrlError || isSavingWebDav}
                aria-busy={isSavingWebDav}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 whitespace-nowrap disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed"
            >
                {t.webdavSave}
            </button>
            <ConnectionBadge
                state={webdavTestState}
                successLabel={t.dropboxTestReachable}
                errorLabel={t.dropboxTestFailed}
            />
        </div>
        <p className="text-xs text-muted-foreground">{t.webdavTestHint}</p>
    </div>
);

export function SyncConfigurationSection({
    cloudProvider,
    cloudToken,
    cloudUrl,
    cloudUrlError,
    dropboxBusy,
    dropboxAuthInProgress,
    dropboxConfigured,
    dropboxConnected,
    dropboxRedirectUri,
    dropboxTestState,
    isMacOS,
    isSavingWebDav,
    isTauri,
    isTestingWebDav,
    onBrowseSyncPath,
    onCloudProviderChange,
    onCloudTokenChange,
    onCloudUrlChange,
    onConnectDropbox,
    onDisconnectDropbox,
    onSaveCloud,
    onSaveSyncPath,
    onSaveWebDav,
    onSetSyncBackend,
    onSyncPathChange,
    onTestDropboxConnection,
    onTestWebDavConnection,
    onWebdavPasswordChange,
    onWebdavUrlChange,
    onWebdavUsernameChange,
    syncBackend,
    syncPath,
    t,
    webdavHasPassword,
    webdavPassword,
    webdavTestState,
    webdavUrl,
    webdavUrlError,
    webdavUsername,
}: SyncConfigurationSectionProps) {
    return (
        <section className="space-y-3">
            <h2 className="text-lg font-semibold flex items-center gap-2">
                <RefreshCw className="w-5 h-5" />
                {t.sync}
            </h2>

            <div className="bg-card border border-border rounded-lg p-6 space-y-4">
                <p className="text-sm text-muted-foreground">{t.syncDescription}</p>

                <div className="flex items-center justify-between gap-4">
                    <span className="text-sm font-medium">{t.syncBackend}</span>
                    <div className="flex gap-2">
                        <BackendButton active={syncBackend === 'off'} onClick={() => onSetSyncBackend('off')}>
                            {t.syncBackendOff}
                        </BackendButton>
                        <BackendButton active={syncBackend === 'file'} onClick={() => onSetSyncBackend('file')}>
                            {t.syncBackendFile}
                        </BackendButton>
                        <BackendButton active={syncBackend === 'webdav'} onClick={() => onSetSyncBackend('webdav')}>
                            {t.syncBackendWebdav}
                        </BackendButton>
                        <BackendButton
                            active={syncBackend === 'cloud' || syncBackend === 'cloudkit'}
                            onClick={() => {
                                if (syncBackend !== 'cloud' && syncBackend !== 'cloudkit') {
                                    onSetSyncBackend('cloud');
                                }
                            }}
                        >
                            {t.syncBackendCloud}
                        </BackendButton>
                    </div>
                </div>

                {syncBackend === 'file' && (
                    <div className="flex flex-col gap-2">
                        <label className="text-sm font-medium">{t.syncFolderLocation}</label>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={syncPath}
                                onChange={(e) => onSyncPathChange(e.target.value)}
                                placeholder="/path/to/your/sync/folder"
                                className="flex-1 bg-muted p-2 rounded text-sm font-mono border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                            />
                            <button
                                onClick={onSaveSyncPath}
                                disabled={!syncPath.trim() || !isTauri}
                                className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed whitespace-nowrap"
                            >
                                {t.savePath}
                            </button>
                            <button
                                onClick={onBrowseSyncPath}
                                disabled={!isTauri}
                                className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md text-sm font-medium hover:bg-secondary/90 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {t.browse}
                            </button>
                        </div>
                        <p className="text-xs text-muted-foreground">{t.pathHint}</p>
                    </div>
                )}

                {syncBackend === 'webdav' && renderWebDavPanel({
                    isSavingWebDav,
                    isTauri,
                    isTestingWebDav,
                    onSaveWebDav,
                    onTestWebDavConnection,
                    onWebdavPasswordChange,
                    onWebdavUrlChange,
                    onWebdavUsernameChange,
                    t,
                    webdavHasPassword,
                    webdavPassword,
                    webdavTestState,
                    webdavUrl,
                    webdavUrlError,
                    webdavUsername,
                })}

                {(syncBackend === 'cloud' || syncBackend === 'cloudkit') && (
                    <div className="space-y-4">
                        <div className="flex items-center justify-between gap-4">
                            <span className="text-sm font-medium">{t.cloudProvider}</span>
                            <div className="flex gap-2">
                                <BackendButton
                                    active={syncBackend === 'cloud' && cloudProvider === 'selfhosted'}
                                    onClick={() => {
                                        onCloudProviderChange('selfhosted');
                                        if (syncBackend !== 'cloud') onSetSyncBackend('cloud');
                                    }}
                                >
                                    {t.cloudProviderSelfHosted}
                                </BackendButton>
                                <BackendButton
                                    active={syncBackend === 'cloud' && cloudProvider === 'dropbox'}
                                    onClick={() => {
                                        onCloudProviderChange('dropbox');
                                        if (syncBackend !== 'cloud') onSetSyncBackend('cloud');
                                    }}
                                >
                                    {t.cloudProviderDropbox}
                                </BackendButton>
                                {isMacOS && (
                                    <BackendButton
                                        active={syncBackend === 'cloudkit'}
                                        onClick={() => onSetSyncBackend('cloudkit')}
                                    >
                                        {t.cloudProviderCloudkit}
                                    </BackendButton>
                                )}
                            </div>
                        </div>

                        {syncBackend === 'cloud' && cloudProvider === 'selfhosted' && renderSelfHostedCloudPanel({
                            cloudToken,
                            cloudUrl,
                            cloudUrlError,
                            onCloudTokenChange,
                            onCloudUrlChange,
                            onSaveCloud,
                            t,
                        })}

                        {syncBackend === 'cloudkit' && (
                            <p className="text-sm text-muted-foreground">{t.cloudkitDesc}</p>
                        )}

                        {syncBackend === 'cloud' && cloudProvider === 'dropbox' && renderDropboxPanel({
                            dropboxBusy,
                            dropboxAuthInProgress,
                            dropboxConfigured,
                            dropboxConnected,
                            dropboxRedirectUri,
                            dropboxTestState,
                            onConnectDropbox,
                            onDisconnectDropbox,
                            onTestDropboxConnection,
                            t,
                        })}
                    </div>
                )}
            </div>
        </section>
    );
}
