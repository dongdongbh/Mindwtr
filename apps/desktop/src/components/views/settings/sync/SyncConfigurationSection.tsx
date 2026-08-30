import { AlertCircle, CheckCircle2, ExternalLink, RefreshCw } from 'lucide-react';
import { cn } from '../../../../lib/utils';
import { Switch } from '../../../ui/Switch';
import { SettingField, SettingRow } from '../SettingRow';
import type { SettingsSyncPageProps } from './types';

const isDocumentPortalPath = (path: string): boolean => (
    /^\/run\/user\/\d+\/doc(?:\/|$)/.test(path.trim())
);

type SyncConfigurationSectionProps = Pick<
    SettingsSyncPageProps,
    | 't'
    | 'isTauri'
    | 'isMacOS'
    | 'webdavUrlError'
    | 'cloudUrlError'
    | 'syncBackend'
    | 'onSetSyncBackend'
    | 'syncPath'
    | 'onSyncPathChange'
    | 'onSaveSyncPath'
    | 'onBrowseSyncPath'
    | 'isTestingSyncPath'
    | 'onTestSyncPath'
    | 'webdavUrl'
    | 'webdavUsername'
    | 'webdavPassword'
    | 'webdavHasPassword'
    | 'webdavAllowInsecureHttp'
    | 'isSavingWebDav'
    | 'isTestingWebDav'
    | 'webdavTestState'
    | 'onWebdavUrlChange'
    | 'onWebdavUsernameChange'
    | 'onWebdavPasswordChange'
    | 'onWebdavAllowInsecureHttpChange'
    | 'onSaveWebDav'
    | 'onTestWebDavConnection'
    | 'cloudUrl'
    | 'cloudToken'
    | 'cloudRememberToken'
    | 'cloudAllowInsecureHttp'
    | 'cloudProvider'
    | 'dropboxConfigured'
    | 'dropboxConnected'
    | 'dropboxBusy'
    | 'dropboxAuthInProgress'
    | 'dropboxRedirectUri'
    | 'dropboxTestState'
    | 'onCloudUrlChange'
    | 'onCloudTokenChange'
    | 'onCloudRememberTokenChange'
    | 'onCloudAllowInsecureHttpChange'
    | 'onCloudProviderChange'
    | 'onSaveCloud'
    | 'calendarFeedUrl'
    | 'calendarFeedBusy'
    | 'onCopyCalendarFeedUrl'
    | 'onGenerateCalendarFeed'
    | 'onRevokeCalendarFeed'
    | 'onConnectDropbox'
    | 'onDisconnectDropbox'
    | 'onTestDropboxConnection'
>;

type BackendButtonOption = 'off' | 'file' | 'dropbox' | 'webdav' | 'selfhosted' | 'cloudkit';
type BackendButtonGroup = {
    description: string;
    options: BackendButtonOption[];
    title: string;
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
        aria-pressed={active}
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

// Connection options that belong to the backend form around them rather than
// being settings of their own, so they carry no search key.
const CONNECTION_OPTION_ROW_CLS = 'rounded-md border border-border bg-muted/30 p-3';

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
                    ? 'border-success/40 text-success'
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
        <SettingField settingsKey="dropboxAppKey" title={t.dropboxAppKey} description={t.dropboxAppKeyHint}>
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
        </SettingField>

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

const renderCalendarFeedPanel = ({
    calendarFeedBusy,
    calendarFeedUrl,
    onCopyCalendarFeedUrl,
    onGenerateCalendarFeed,
    onRevokeCalendarFeed,
    t,
}: Pick<
    SyncConfigurationSectionProps,
    | 'calendarFeedBusy'
    | 'calendarFeedUrl'
    | 'onCopyCalendarFeedUrl'
    | 'onGenerateCalendarFeed'
    | 'onRevokeCalendarFeed'
    | 't'
>) => (
    <SettingField
        settingsKey="calendarFeed"
        title={t.calendarFeed}
        description={t.calendarFeedDesc}
        className="border-t border-border pt-3"
    >
        {calendarFeedUrl ? (
            <input
                type="text"
                readOnly
                value={calendarFeedUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="bg-muted p-2 rounded text-sm font-mono border border-border focus:outline-none focus:ring-2 focus:ring-primary"
            />
        ) : (
            <p className="text-xs text-muted-foreground">{t.calendarFeedNone}</p>
        )}
        <p className="text-xs text-muted-foreground">{t.calendarFeedWarning}</p>
        <div className="flex flex-wrap justify-end gap-2">
            {calendarFeedUrl && (
                <>
                    <button
                        onClick={onCopyCalendarFeedUrl}
                        className="px-3 py-2 border border-border rounded-md text-sm font-medium hover:bg-muted whitespace-nowrap"
                    >
                        {t.calendarFeedCopy}
                    </button>
                    <button
                        onClick={onRevokeCalendarFeed}
                        disabled={calendarFeedBusy}
                        className="px-3 py-2 border border-border rounded-md text-sm font-medium text-destructive hover:bg-muted whitespace-nowrap disabled:text-muted-foreground disabled:cursor-not-allowed"
                    >
                        {t.calendarFeedRevoke}
                    </button>
                </>
            )}
            <button
                onClick={onGenerateCalendarFeed}
                disabled={calendarFeedBusy}
                className="px-3 py-2 border border-border rounded-md text-sm font-medium hover:bg-muted whitespace-nowrap disabled:text-muted-foreground disabled:cursor-not-allowed"
            >
                {calendarFeedUrl ? t.calendarFeedRegenerate : t.calendarFeedGenerate}
            </button>
        </div>
    </SettingField>
);

const renderSelfHostedCloudPanel = ({
    calendarFeedBusy,
    calendarFeedUrl,
    cloudAllowInsecureHttp,
    cloudRememberToken,
    cloudToken,
    cloudUrl,
    cloudUrlError,
    isTauri,
    onCloudAllowInsecureHttpChange,
    onCloudRememberTokenChange,
    onCloudTokenChange,
    onCloudUrlChange,
    onCopyCalendarFeedUrl,
    onGenerateCalendarFeed,
    onRevokeCalendarFeed,
    onSaveCloud,
    t,
}: Pick<
    SyncConfigurationSectionProps,
    | 'calendarFeedBusy'
    | 'calendarFeedUrl'
    | 'cloudAllowInsecureHttp'
    | 'cloudRememberToken'
    | 'cloudToken'
    | 'cloudUrl'
    | 'isTauri'
    | 'onCloudAllowInsecureHttpChange'
    | 'onCloudRememberTokenChange'
    | 'onCloudTokenChange'
    | 'onCloudUrlChange'
    | 'onCopyCalendarFeedUrl'
    | 'onGenerateCalendarFeed'
    | 'onRevokeCalendarFeed'
    | 'onSaveCloud'
    | 't'
> & { cloudUrlError: boolean }) => (
    <div className="space-y-3">
        <SettingField settingsKey="cloudUrl" title={t.cloudUrl}>
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
        </SettingField>

        <SettingRow
            settingsKey={null}
            title={t.allowInsecureHttp}
            description={t.allowInsecureHttpHint}
            className={CONNECTION_OPTION_ROW_CLS}
        >
            <Switch
                aria-label={t.allowInsecureHttp}
                checked={cloudAllowInsecureHttp}
                onCheckedChange={onCloudAllowInsecureHttpChange}
            />
        </SettingRow>

        <SettingField settingsKey="cloudToken" title={t.cloudToken}>
            <input
                type="password"
                value={cloudToken}
                onChange={(e) => onCloudTokenChange(e.target.value)}
                className="bg-muted p-2 rounded text-sm border border-border focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <p className="text-xs text-muted-foreground">{t.cloudTokenHint}</p>
        </SettingField>

        {!isTauri && (
            <SettingRow
                settingsKey={null}
                title={t.cloudRememberToken}
                description={t.cloudRememberTokenHint}
                className={CONNECTION_OPTION_ROW_CLS}
            >
                <Switch
                    aria-label={t.cloudRememberToken}
                    checked={cloudRememberToken}
                    onCheckedChange={onCloudRememberTokenChange}
                />
            </SettingRow>
        )}

        <div className="flex justify-end">
            <button
                onClick={onSaveCloud}
                disabled={cloudUrlError}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 whitespace-nowrap disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed"
            >
                {t.cloudSave}
            </button>
        </div>

        {renderCalendarFeedPanel({
            calendarFeedBusy,
            calendarFeedUrl,
            onCopyCalendarFeedUrl,
            onGenerateCalendarFeed,
            onRevokeCalendarFeed,
            t,
        })}
    </div>
);

const renderWebDavPanel = ({
    isSavingWebDav,
    isTauri,
    isTestingWebDav,
    onSaveWebDav,
    onTestWebDavConnection,
    onWebdavAllowInsecureHttpChange,
    onWebdavPasswordChange,
    onWebdavUrlChange,
    onWebdavUsernameChange,
    t,
    webdavAllowInsecureHttp,
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
    | 'onWebdavAllowInsecureHttpChange'
    | 'onWebdavPasswordChange'
    | 'onWebdavUrlChange'
    | 'onWebdavUsernameChange'
    | 't'
    | 'webdavAllowInsecureHttp'
    | 'webdavHasPassword'
    | 'webdavPassword'
    | 'webdavTestState'
    | 'webdavUrl'
    | 'webdavUsername'
> & { webdavUrlError: boolean }) => (
    <div className="space-y-3">
        <SettingField settingsKey="webdavUrl" title={t.webdavUrl}>
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
        </SettingField>

        <SettingRow
            settingsKey={null}
            title={t.allowInsecureHttp}
            description={t.allowInsecureHttpHint}
            className={CONNECTION_OPTION_ROW_CLS}
        >
            <Switch
                aria-label={t.allowInsecureHttp}
                checked={webdavAllowInsecureHttp}
                onCheckedChange={onWebdavAllowInsecureHttpChange}
            />
        </SettingRow>

        <div className="grid sm:grid-cols-2 gap-2">
            <SettingField settingsKey="webdavUsername" title={t.webdavUsername}>
                <input
                    type="text"
                    value={webdavUsername}
                    onChange={(e) => onWebdavUsernameChange(e.target.value)}
                    className="bg-muted p-2 rounded text-sm border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                />
            </SettingField>
            <SettingField settingsKey="webdavPassword" title={t.webdavPassword}>
                <input
                    type="password"
                    value={webdavPassword}
                    onChange={(e) => onWebdavPasswordChange(e.target.value)}
                    placeholder={webdavHasPassword && !webdavPassword ? '••••••••' : ''}
                    className="bg-muted p-2 rounded text-sm border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                />
            </SettingField>
        </div>
        {!isTauri && (
            <p className="text-xs text-warning">
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
    calendarFeedBusy,
    calendarFeedUrl,
    cloudAllowInsecureHttp,
    cloudRememberToken,
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
    isTestingSyncPath,
    isTestingWebDav,
    onBrowseSyncPath,
    onCloudAllowInsecureHttpChange,
    onCloudRememberTokenChange,
    onCloudProviderChange,
    onCloudTokenChange,
    onCloudUrlChange,
    onConnectDropbox,
    onCopyCalendarFeedUrl,
    onDisconnectDropbox,
    onGenerateCalendarFeed,
    onRevokeCalendarFeed,
    onSaveCloud,
    onSaveSyncPath,
    onSaveWebDav,
    onSetSyncBackend,
    onSyncPathChange,
    onTestDropboxConnection,
    onTestSyncPath,
    onTestWebDavConnection,
    onWebdavAllowInsecureHttpChange,
    onWebdavPasswordChange,
    onWebdavUrlChange,
    onWebdavUsernameChange,
    syncBackend,
    syncPath,
    t,
    webdavAllowInsecureHttp,
    webdavHasPassword,
    webdavPassword,
    webdavTestState,
    webdavUrl,
    webdavUrlError,
    webdavUsername,
}: SyncConfigurationSectionProps) {
    const isSelfHostedSelected = syncBackend === 'cloud' && cloudProvider === 'selfhosted';
    const isDropboxSelected = syncBackend === 'cloud' && cloudProvider === 'dropbox';
    const backendGroups: BackendButtonGroup[] = [
        {
            title: t.syncBackendGroupCloud,
            description: t.syncBackendGroupCloudDesc,
            options: ['dropbox', ...(isMacOS ? (['cloudkit'] as const) : [])],
        },
        {
            title: t.syncBackendGroupFile,
            description: t.syncBackendGroupFileDesc,
            options: ['file'],
        },
        {
            title: t.syncBackendGroupAdvanced,
            description: t.syncBackendGroupAdvancedDesc,
            options: ['webdav', 'selfhosted'],
        },
    ];
    const backendControlOptions: BackendButtonOption[] = [
        'off',
        ...backendGroups.flatMap((group) => group.options),
    ];
    const getBackendOptionLabel = (option: BackendButtonOption): string => {
        switch (option) {
            case 'off':
                return t.syncBackendOff;
            case 'file':
                return t.syncBackendFile;
            case 'dropbox':
                return t.cloudProviderDropbox;
            case 'webdav':
                return t.syncBackendWebdav;
            case 'selfhosted':
                return t.cloudProviderSelfHosted;
            case 'cloudkit':
                return t.syncBackendCloudkit;
        }
    };
    const isBackendOptionActive = (option: BackendButtonOption): boolean => {
        switch (option) {
            case 'off':
            case 'file':
            case 'webdav':
                return syncBackend === option;
            case 'dropbox':
                return isDropboxSelected;
            case 'selfhosted':
                return isSelfHostedSelected;
            case 'cloudkit':
                return syncBackend === 'cloudkit';
        }
    };
    const selectedBackendGroup = backendGroups.find((group) =>
        group.options.some((option) => isBackendOptionActive(option))
    );
    const selectBackendOption = (option: BackendButtonOption) => {
        switch (option) {
            case 'dropbox':
                onCloudProviderChange('dropbox');
                if (syncBackend !== 'cloud') onSetSyncBackend('cloud');
                return;
            case 'selfhosted':
                onCloudProviderChange('selfhosted');
                if (syncBackend !== 'cloud') onSetSyncBackend('cloud');
                return;
            case 'cloudkit':
                onSetSyncBackend('cloudkit');
                return;
            default:
                onSetSyncBackend(option);
        }
    };

    return (
        <section className="space-y-3">
            <h2 className="text-lg font-semibold flex items-center gap-2">
                <RefreshCw className="w-5 h-5" />
                {t.sync}
            </h2>

            <div className="bg-card border border-border rounded-lg p-6 space-y-4">
                <a
                    href="https://docs.mindwtr.app/data-sync/"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                >
                    Data and Sync guide
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                </a>

                <SettingField
                    settingsKey="syncBackend"
                    title={t.syncBackend}
                    description={t.syncBackendChoiceHint}
                    className="gap-1"
                />

                <div
                    aria-label={t.syncBackend}
                    className="flex flex-wrap items-center gap-2 rounded-md bg-muted/30 p-2"
                    role="group"
                >
                    {backendControlOptions.map((option) => (
                        <BackendButton
                            key={option}
                            active={isBackendOptionActive(option)}
                            onClick={() => selectBackendOption(option)}
                        >
                            {getBackendOptionLabel(option)}
                        </BackendButton>
                    ))}
                </div>

                {selectedBackendGroup && (
                    <div className="space-y-1">
                        <div className="text-sm font-semibold text-foreground">{selectedBackendGroup.title}</div>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                            {selectedBackendGroup.description}
                        </p>
                    </div>
                )}

                {syncBackend === 'file' && (
                    <SettingField settingsKey="syncFolderLocation" title={t.syncFolderLocation}>
                        <div className="flex flex-wrap gap-2">
                            <input
                                type="text"
                                aria-label={t.syncFolderLocation}
                                value={syncPath}
                                onChange={(e) => onSyncPathChange(e.target.value)}
                                placeholder="/path/to/your/sync/folder"
                                className="min-w-64 flex-1 bg-muted p-2 rounded text-sm font-mono border border-border focus:outline-none focus:ring-2 focus:ring-primary"
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
                            <button
                                type="button"
                                onClick={onTestSyncPath}
                                disabled={!syncPath.trim() || !isTauri || isTestingSyncPath}
                                aria-busy={isTestingSyncPath}
                                className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md text-sm font-medium hover:bg-secondary/90 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {isTestingSyncPath ? t.testingFolder : t.testFolder}
                            </button>
                        </div>
                        <p className="text-xs text-muted-foreground">{t.pathHint}</p>
                        {isDocumentPortalPath(syncPath) && (
                            <p className="text-xs text-muted-foreground leading-relaxed">
                                {t.portalPathNote}
                            </p>
                        )}
                    </SettingField>
                )}

                {syncBackend === 'webdav' && renderWebDavPanel({
                    isSavingWebDav,
                    isTauri,
                    isTestingWebDav,
                    onSaveWebDav,
                    onTestWebDavConnection,
                    onWebdavAllowInsecureHttpChange,
                    onWebdavPasswordChange,
                    onWebdavUrlChange,
                    onWebdavUsernameChange,
                    t,
                    webdavAllowInsecureHttp,
                    webdavHasPassword,
                    webdavPassword,
                    webdavTestState,
                    webdavUrl,
                    webdavUrlError,
                    webdavUsername,
                })}

                {isSelfHostedSelected && renderSelfHostedCloudPanel({
                    calendarFeedBusy,
                    calendarFeedUrl,
                    cloudAllowInsecureHttp,
                    cloudRememberToken,
                    cloudToken,
                    cloudUrl,
                    cloudUrlError,
                    isTauri,
                    onCloudAllowInsecureHttpChange,
                    onCloudRememberTokenChange,
                    onCloudTokenChange,
                    onCloudUrlChange,
                    onCopyCalendarFeedUrl,
                    onGenerateCalendarFeed,
                    onRevokeCalendarFeed,
                    onSaveCloud,
                    t,
                })}

                {syncBackend === 'cloudkit' && (
                    <p className="text-sm text-muted-foreground">{t.cloudkitDesc}</p>
                )}

                {isDropboxSelected && renderDropboxPanel({
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
        </section>
    );
}
