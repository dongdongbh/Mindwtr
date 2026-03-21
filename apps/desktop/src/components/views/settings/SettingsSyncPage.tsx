import { useState } from 'react';
import type { AppData } from '@mindwtr/core';
import { safeFormatDate } from '@mindwtr/core';
import { Info, RefreshCw, Trash2 } from 'lucide-react';

import { cn } from '../../../lib/utils';
import { ConfirmModal } from '../../ConfirmModal';

type Labels = {
    diagnostics: string;
    diagnosticsDesc: string;
    debugLogging: string;
    debugLoggingDesc: string;
    logFile: string;
    clearLog: string;
    sync: string;
    syncDescription: string;
    syncBackend: string;
    syncBackendOff: string;
    syncBackendFile: string;
    syncBackendWebdav: string;
    syncBackendCloud: string;
    syncBackendCloudkit: string;
    syncPreferences: string;
    syncPreferencesDesc: string;
    syncPreferenceAppearance: string;
    syncPreferenceLanguage: string;
    syncPreferenceExternalCalendars: string;
    syncPreferenceAi: string;
    syncPreferenceAiHint: string;
    syncFolderLocation: string;
    savePath: string;
    browse: string;
    pathHint: string;
    webdavUrl: string;
    webdavHint: string;
    webdavUsername: string;
    webdavPassword: string;
    webdavSave: string;
    testConnection: string;
    webdavTestHint: string;
    webdavTestAccessibility: string;
    cloudUrl: string;
    cloudHint: string;
    cloudToken: string;
    cloudSave: string;
    cloudProvider: string;
    cloudProviderSelfHosted: string;
    cloudProviderDropbox: string;
    dropboxAppKey: string;
    dropboxAppKeyHint: string;
    dropboxRedirectUri: string;
    dropboxStatus: string;
    dropboxConnected: string;
    dropboxNotConnected: string;
    dropboxConnect: string;
    dropboxDisconnect: string;
    dropboxTest: string;
    dropboxTestReachable: string;
    dropboxTestFailed: string;
    syncNow: string;
    syncing: string;
    syncQueued: string;
    lastSync: string;
    lastSyncSuccess: string;
    lastSyncConflict: string;
    lastSyncError: string;
    lastSyncConflicts: string;
    lastSyncSkew: string;
    lastSyncAdjusted: string;
    lastSyncConflictIds: string;
    syncHistory: string;
    recoverySnapshots: string;
    recoverySnapshotsDesc: string;
    recoverySnapshotsLoading: string;
    recoverySnapshotsEmpty: string;
    recoverySnapshotsRestore: string;
    recoverySnapshotsConfirm: string;
    recoverySnapshotsConfirmTitle: string;
    recoverySnapshotsConfirmCancel: string;
    attachmentsCleanup: string;
    attachmentsCleanupDesc: string;
    attachmentsCleanupLastRun: string;
    attachmentsCleanupNever: string;
    attachmentsCleanupRun: string;
    attachmentsCleanupRunning: string;
};

import type { SyncBackend } from '@mindwtr/core';
type CloudProvider = 'selfhosted' | 'dropbox';
type DropboxTestState = 'idle' | 'success' | 'error';

type SettingsSyncPageProps = {
    t: Labels;
    isTauri: boolean;
    loggingEnabled: boolean;
    logPath: string;
    onToggleLogging: () => void;
    onClearLog: () => void;
    syncBackend: SyncBackend;
    onSetSyncBackend: (backend: SyncBackend) => void;
    syncPreferences: AppData['settings']['syncPreferences'] | undefined;
    onUpdateSyncPreferences: (updates: Partial<NonNullable<AppData['settings']['syncPreferences']>>) => Promise<void> | void;
    syncPath: string;
    onSyncPathChange: (value: string) => void;
    onSaveSyncPath: () => Promise<void> | void;
    onBrowseSyncPath: () => void;
    webdavUrl: string;
    webdavUsername: string;
    webdavPassword: string;
    webdavHasPassword: boolean;
    isSavingWebDav: boolean;
    isTestingWebDav: boolean;
    webdavTestState: 'idle' | 'success' | 'error';
    onWebdavUrlChange: (value: string) => void;
    onWebdavUsernameChange: (value: string) => void;
    onWebdavPasswordChange: (value: string) => void;
    onSaveWebDav: () => Promise<void> | void;
    onTestWebDavConnection: () => Promise<void> | void;
    cloudUrl: string;
    cloudToken: string;
    cloudProvider: CloudProvider;
    dropboxAppKey: string;
    dropboxConfigured: boolean;
    dropboxConnected: boolean;
    dropboxBusy: boolean;
    dropboxRedirectUri: string;
    dropboxTestState: DropboxTestState;
    onCloudUrlChange: (value: string) => void;
    onCloudTokenChange: (value: string) => void;
    onCloudProviderChange: (provider: CloudProvider) => void;
    onSaveCloud: () => Promise<void> | void;
    onConnectDropbox: () => Promise<void> | void;
    onDisconnectDropbox: () => Promise<void> | void;
    onTestDropboxConnection: () => Promise<void> | void;
    onSyncNow: () => Promise<void> | void;
    isSyncing: boolean;
    syncQueued: boolean;
    syncLastResult: 'success' | 'error' | null;
    syncLastResultAt: string | null;
    syncError: string | null;
    lastSyncDisplay: string;
    lastSyncStatus: AppData['settings']['lastSyncStatus'];
    lastSyncStats: AppData['settings']['lastSyncStats'] | null;
    lastSyncHistory: AppData['settings']['lastSyncHistory'] | null;
    conflictCount: number;
    lastSyncError?: string;
    attachmentsLastCleanupDisplay: string;
    onRunAttachmentsCleanup: () => Promise<void> | void;
    isCleaningAttachments: boolean;
    snapshots: string[];
    isLoadingSnapshots: boolean;
    isRestoringSnapshot: boolean;
    onRestoreSnapshot: (snapshotFileName: string) => Promise<boolean | void> | boolean | void;
};

const isValidHttpUrl = (value: string): boolean => {
    if (!value.trim()) return false;
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
};

const formatClockSkew = (ms: number): string => {
    if (!Number.isFinite(ms) || ms <= 0) return '0 ms';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
    const minutes = seconds / 60;
    return `${minutes.toFixed(1)} min`;
};

export function SettingsSyncPage({
    t,
    isTauri,
    loggingEnabled,
    logPath,
    onToggleLogging,
    onClearLog,
    syncBackend,
    onSetSyncBackend,
    syncPreferences,
    onUpdateSyncPreferences,
    syncPath,
    onSyncPathChange,
    onSaveSyncPath,
    onBrowseSyncPath,
    webdavUrl,
    webdavUsername,
    webdavPassword,
    webdavHasPassword,
    isSavingWebDav,
    isTestingWebDav,
    webdavTestState,
    onWebdavUrlChange,
    onWebdavUsernameChange,
    onWebdavPasswordChange,
    onSaveWebDav,
    onTestWebDavConnection,
    cloudUrl,
    cloudToken,
    cloudProvider,
    dropboxAppKey,
    dropboxConfigured,
    dropboxConnected,
    dropboxBusy,
    dropboxRedirectUri,
    dropboxTestState,
    onCloudUrlChange,
    onCloudTokenChange,
    onCloudProviderChange,
    onSaveCloud,
    onConnectDropbox,
    onDisconnectDropbox,
    onTestDropboxConnection,
    onSyncNow,
    isSyncing,
    syncQueued,
    syncLastResult,
    syncLastResultAt,
    syncError,
    lastSyncDisplay,
    lastSyncStatus,
    lastSyncStats,
    lastSyncHistory,
    conflictCount,
    lastSyncError,
    attachmentsLastCleanupDisplay,
    onRunAttachmentsCleanup,
    isCleaningAttachments,
    snapshots,
    isLoadingSnapshots,
    isRestoringSnapshot,
    onRestoreSnapshot,
}: SettingsSyncPageProps) {
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
                        : dropboxConfigured && !!dropboxAppKey.trim() && dropboxConnected)
                    : false;
    const maxClockSkewMs = Math.max(lastSyncStats?.tasks.maxClockSkewMs ?? 0, lastSyncStats?.projects.maxClockSkewMs ?? 0);
    const timestampAdjustments = (lastSyncStats?.tasks.timestampAdjustments ?? 0) + (lastSyncStats?.projects.timestampAdjustments ?? 0);
    const conflictIds = [
        ...(lastSyncStats?.tasks.conflictIds ?? []),
        ...(lastSyncStats?.projects.conflictIds ?? []),
    ].slice(0, 6);
    const historyEntries = (lastSyncHistory ?? []).slice(0, 6);
    const syncPrefs = syncPreferences ?? {};
    const recentResultLabel = (() => {
        if (!syncLastResultAt || !syncLastResult) return null;
        const timestamp = Date.parse(syncLastResultAt);
        if (!Number.isFinite(timestamp)) return null;
        if (Date.now() - timestamp > 8000) return null;
        return syncLastResult === 'success' ? t.lastSyncSuccess : t.lastSyncError;
    })();
    const syncStatusLabel = isSyncing
        ? (syncQueued ? t.syncQueued : t.syncing)
        : recentResultLabel;
    const syncStatusTone = isSyncing
        ? 'text-muted-foreground'
        : syncLastResult === 'error'
            ? 'text-destructive'
            : 'text-muted-foreground';
    const formatHistoryStatus = (status: 'success' | 'conflict' | 'error') => {
        if (status === 'success') return t.lastSyncSuccess;
        if (status === 'conflict') return t.lastSyncConflict;
        return t.lastSyncError;
    };
    const [syncOptionsOpen, setSyncOptionsOpen] = useState(false);
    const [syncHistoryOpen, setSyncHistoryOpen] = useState(false);
    const [snapshotsOpen, setSnapshotsOpen] = useState(false);
    const [snapshotToRestore, setSnapshotToRestore] = useState<string | null>(null);
    const formatSnapshotLabel = (fileName: string) => {
        const match = fileName.match(/^data\.(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.snapshot\.json$/);
        if (!match) return fileName;
        const [, day, hh, mm, ss] = match;
        const [year, month, date] = day.split('-').map((part) => Number.parseInt(part, 10));
        const hour = Number.parseInt(hh, 10);
        const minute = Number.parseInt(mm, 10);
        const second = Number.parseInt(ss, 10);
        if (![year, month, date, hour, minute, second].every(Number.isFinite)) return fileName;
        const utc = new Date(Date.UTC(year, month - 1, date, hour, minute, second));
        if (Number.isNaN(utc.getTime())) return fileName;
        return utc.toLocaleString();
    };

    const renderSyncToggle = (
        key: keyof NonNullable<AppData['settings']['syncPreferences']>,
        label: string,
        hint?: string
    ) => {
        const checked = syncPrefs?.[key] === true;
        return (
            <div className="flex items-start justify-between gap-4">
                <div>
                    <p className="text-sm font-medium">{label}</p>
                    {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={checked}
                    onClick={() => onUpdateSyncPreferences({ [key]: !checked } as Partial<NonNullable<AppData['settings']['syncPreferences']>>)}
                    className={cn(
                        "relative inline-flex h-5 w-9 items-center rounded-full border transition-colors",
                        checked ? "bg-primary border-primary" : "bg-muted/50 border-border",
                    )}
                >
                    <span
                        className={cn(
                            "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
                            checked ? "translate-x-4" : "translate-x-1",
                        )}
                    />
                </button>
            </div>
        );
    };

    return (
        <div className="space-y-8">
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
                            <button
                                onClick={() => onSetSyncBackend('off')}
                                className={cn(
                                    "px-3 py-1.5 rounded-md text-sm font-medium transition-colors border",
                                    syncBackend === 'off'
                                        ? "bg-primary/10 text-primary border-primary ring-1 ring-primary"
                                        : "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground",
                                )}
                            >
                                {t.syncBackendOff}
                            </button>
                            <button
                                onClick={() => onSetSyncBackend('file')}
                                className={cn(
                                    "px-3 py-1.5 rounded-md text-sm font-medium transition-colors border",
                                    syncBackend === 'file'
                                        ? "bg-primary/10 text-primary border-primary ring-1 ring-primary"
                                        : "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground",
                                )}
                            >
                                {t.syncBackendFile}
                            </button>
                            <button
                                onClick={() => onSetSyncBackend('webdav')}
                                className={cn(
                                    "px-3 py-1.5 rounded-md text-sm font-medium transition-colors border",
                                    syncBackend === 'webdav'
                                        ? "bg-primary/10 text-primary border-primary ring-1 ring-primary"
                                        : "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground",
                                )}
                            >
                                {t.syncBackendWebdav}
                            </button>
                            <button
                                onClick={() => onSetSyncBackend('cloud')}
                                className={cn(
                                    "px-3 py-1.5 rounded-md text-sm font-medium transition-colors border",
                                    syncBackend === 'cloud'
                                        ? "bg-primary/10 text-primary border-primary ring-1 ring-primary"
                                        : "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground",
                                )}
                            >
                                {t.syncBackendCloud}
                            </button>
                            {isMacOS && (
                                <button
                                    onClick={() => onSetSyncBackend('cloudkit')}
                                    className={cn(
                                        "px-3 py-1.5 rounded-md text-sm font-medium transition-colors border",
                                        syncBackend === 'cloudkit'
                                            ? "bg-primary/10 text-primary border-primary ring-1 ring-primary"
                                            : "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground",
                                    )}
                                >
                                    {t.syncBackendCloudkit}
                                </button>
                            )}
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

                    {syncBackend === 'webdav' && (
                        <div className="space-y-3">
                            <div className="flex flex-col gap-2">
                                <label className="text-sm font-medium">{t.webdavUrl}</label>
                                <input
                                    type="text"
                                    value={webdavUrl}
                                    onChange={(e) => onWebdavUrlChange(e.target.value)}
                                    placeholder="https://example.com/remote.php/dav/files/user/data.json"
                                    className={cn(
                                        "bg-muted p-2 rounded text-sm font-mono border focus:outline-none focus:ring-2 focus:ring-primary",
                                        webdavUrlError ? "border-destructive" : "border-border",
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
                                {webdavTestState !== 'idle' && (
                                    <span
                                        className={cn(
                                            "inline-flex items-center rounded-md border px-2 py-1 text-xs",
                                            webdavTestState === 'success'
                                                ? "border-emerald-600/40 text-emerald-500"
                                                : "border-destructive/40 text-destructive"
                                        )}
                                    >
                                        {webdavTestState === 'success' ? `✓ ${t.dropboxTestReachable}` : `! ${t.dropboxTestFailed}`}
                                    </span>
                                )}
                            </div>
                            <p className="text-xs text-muted-foreground">{t.webdavTestHint}</p>
                        </div>
                    )}

                    {syncBackend === 'cloud' && (
                        <div className="space-y-4">
                            <div className="flex items-center justify-between gap-4">
                                <span className="text-sm font-medium">{t.cloudProvider}</span>
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => onCloudProviderChange('selfhosted')}
                                        className={cn(
                                            "px-3 py-1.5 rounded-md text-sm font-medium transition-colors border",
                                            cloudProvider === 'selfhosted'
                                                ? "bg-primary/10 text-primary border-primary ring-1 ring-primary"
                                                : "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground",
                                        )}
                                    >
                                        {t.cloudProviderSelfHosted}
                                    </button>
                                    <button
                                        onClick={() => onCloudProviderChange('dropbox')}
                                        className={cn(
                                            "px-3 py-1.5 rounded-md text-sm font-medium transition-colors border",
                                            cloudProvider === 'dropbox'
                                                ? "bg-primary/10 text-primary border-primary ring-1 ring-primary"
                                                : "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground",
                                        )}
                                    >
                                        {t.cloudProviderDropbox}
                                    </button>
                                </div>
                            </div>

                            {cloudProvider === 'selfhosted' && (
                                <div className="space-y-3">
                                    <div className="flex flex-col gap-2">
                                        <label className="text-sm font-medium">{t.cloudUrl}</label>
                                        <input
                                            type="text"
                                            value={cloudUrl}
                                            onChange={(e) => onCloudUrlChange(e.target.value)}
                                            placeholder="https://example.com/v1/data"
                                            className={cn(
                                                "bg-muted p-2 rounded text-sm font-mono border focus:outline-none focus:ring-2 focus:ring-primary",
                                                cloudUrlError ? "border-destructive" : "border-border",
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
                            )}

                            {cloudProvider === 'dropbox' && (
                                <div className="space-y-3">
                                    <div className="flex flex-col gap-2">
                                        <label className="text-sm font-medium">{t.dropboxAppKey}</label>
                                        <p className="text-xs text-muted-foreground">{t.dropboxAppKeyHint}</p>
                                        <p className="text-xs text-muted-foreground">
                                            {t.dropboxRedirectUri}: <span className="font-mono break-all">{dropboxRedirectUri}</span>
                                        </p>
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
                                        {dropboxTestState !== 'idle' && (
                                            <span
                                                className={cn(
                                                    "inline-flex items-center rounded-md border px-2 py-1 text-xs",
                                                    dropboxTestState === 'success'
                                                        ? "border-emerald-600/40 text-emerald-500"
                                                        : "border-destructive/40 text-destructive"
                                                )}
                                            >
                                                {dropboxTestState === 'success' ? `✓ ${t.dropboxTestReachable}` : `! ${t.dropboxTestFailed}`}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    <div className="border-t border-border/60 pt-4 space-y-3">
                        <button
                            type="button"
                            onClick={() => setSyncOptionsOpen((prev) => !prev)}
                            className="w-full flex items-start justify-between gap-4 text-left"
                        >
                            <div>
                                <div className="text-sm font-medium">{t.syncPreferences}</div>
                                <p className="text-xs text-muted-foreground">{t.syncPreferencesDesc}</p>
                            </div>
                            <span className="text-muted-foreground">{syncOptionsOpen ? '▾' : '▸'}</span>
                        </button>
                        {syncOptionsOpen && (
                            <div className="space-y-3">
                                {renderSyncToggle('appearance', t.syncPreferenceAppearance)}
                                {renderSyncToggle('language', t.syncPreferenceLanguage)}
                                {renderSyncToggle('externalCalendars', t.syncPreferenceExternalCalendars)}
                                {renderSyncToggle('ai', t.syncPreferenceAi, t.syncPreferenceAiHint)}
                            </div>
                        )}
                    </div>

                    {isSyncTargetValid && (
                        <div className="pt-2 flex items-center gap-3">
                            <button
                                onClick={onSyncNow}
                                disabled={isSyncing}
                                className={cn(
                                    "flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium text-primary-foreground transition-colors",
                                    isSyncing ? "bg-muted text-muted-foreground cursor-not-allowed" : "bg-primary hover:bg-primary/90",
                                )}
                            >
                                <RefreshCw className={cn("w-4 h-4", isSyncing && "animate-spin")} />
                                {isSyncing ? t.syncing : t.syncNow}
                            </button>
                            {syncStatusLabel && (
                                <span className={cn("text-xs", syncStatusTone)}>
                                    {syncStatusLabel}
                                </span>
                            )}
                            {syncError && <span className="text-xs text-destructive">{syncError}</span>}
                        </div>
                    )}

                    <div className="pt-3 text-xs text-muted-foreground space-y-1">
                        <div>
                            {t.lastSync}: {lastSyncDisplay}
                            {lastSyncStatus === 'success' && ` • ${t.lastSyncSuccess}`}
                            {lastSyncStatus === 'conflict' && ` • ${t.lastSyncConflict}`}
                            {lastSyncStatus === 'error' && ` • ${t.lastSyncError}`}
                        </div>
                        {lastSyncStats && (
                            <div>
                                {t.lastSyncConflicts}: {conflictCount} • Tasks {lastSyncStats.tasks.mergedTotal} /
                                Projects {lastSyncStats.projects.mergedTotal}
                            </div>
                        )}
                        {lastSyncStats && maxClockSkewMs > 0 && (
                            <div>
                                {t.lastSyncSkew}: {formatClockSkew(maxClockSkewMs)}
                            </div>
                        )}
                        {lastSyncStats && timestampAdjustments > 0 && (
                            <div>
                                {t.lastSyncAdjusted}: {timestampAdjustments}
                            </div>
                        )}
                        {lastSyncStats && conflictIds.length > 0 && (
                            <div>
                                {t.lastSyncConflictIds}: {conflictIds.join(', ')}
                            </div>
                        )}
                        {lastSyncStatus === 'error' && lastSyncError && (
                            <div className="text-destructive text-xs break-all line-clamp-2" title={lastSyncError}>
                                {lastSyncError}
                            </div>
                        )}
                        {historyEntries.length > 0 && (
                            <div className="pt-2 space-y-1">
                                <button
                                    type="button"
                                    onClick={() => setSyncHistoryOpen((prev) => !prev)}
                                    className="w-full flex items-center justify-between text-left"
                                    aria-expanded={syncHistoryOpen}
                                >
                                    <span className="text-xs font-medium text-muted-foreground">{t.syncHistory}</span>
                                    <span className="text-muted-foreground">{syncHistoryOpen ? '▾' : '▸'}</span>
                                </button>
                                {syncHistoryOpen && (
                                    <div className="space-y-1">
                                        {historyEntries.map((entry) => {
                                            const timestamp = safeFormatDate(entry.at, 'PPpp', entry.at);
                                            const statusLabel = formatHistoryStatus(entry.status);
                                            const parts = [
                                                entry.backend ? `Backend: ${entry.backend}` : null,
                                                entry.type ? `Type: ${entry.type}` : null,
                                                entry.conflicts ? `${t.lastSyncConflicts}: ${entry.conflicts}` : null,
                                                entry.maxClockSkewMs > 0 ? `${t.lastSyncSkew}: ${formatClockSkew(entry.maxClockSkewMs)}` : null,
                                                entry.timestampAdjustments > 0 ? `${t.lastSyncAdjusted}: ${entry.timestampAdjustments}` : null,
                                                entry.details ? `Details: ${entry.details}` : null,
                                            ].filter(Boolean);
                                            return (
                                                <div key={`${entry.at}-${entry.status}`} className="text-xs text-muted-foreground">
                                                    <span className="text-foreground">{timestamp}</span> • {statusLabel}
                                                    {parts.length > 0 && ` • ${parts.join(' • ')}`}
                                                    {entry.status === 'error' && entry.error && ` • ${entry.error}`}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        )}
                        <div className="pt-3 space-y-1">
                            <button
                                type="button"
                                onClick={() => setSnapshotsOpen((prev) => !prev)}
                                className="w-full flex items-center justify-between text-left"
                                aria-expanded={snapshotsOpen}
                            >
                                <span className="text-xs font-medium text-muted-foreground">{t.recoverySnapshots}</span>
                                <span className="text-muted-foreground">{snapshotsOpen ? '▾' : '▸'}</span>
                            </button>
                            <div className="text-xs text-muted-foreground">
                                {t.recoverySnapshotsDesc}
                            </div>
                            {snapshotsOpen && (
                                <div className="mt-2 space-y-1">
                                    {isLoadingSnapshots && (
                                        <div className="text-xs text-muted-foreground">{t.recoverySnapshotsLoading}</div>
                                    )}
                                    {!isLoadingSnapshots && snapshots.length === 0 && (
                                        <div className="text-xs text-muted-foreground">{t.recoverySnapshotsEmpty}</div>
                                    )}
                                    {!isLoadingSnapshots && snapshots.slice(0, 5).map((snapshot) => (
                                        <div key={snapshot} className="flex items-center justify-between gap-2 text-xs">
                                            <span className="text-muted-foreground font-mono truncate">{formatSnapshotLabel(snapshot)}</span>
                                            <button
                                                type="button"
                                                disabled={isRestoringSnapshot}
                                                onClick={() => setSnapshotToRestore(snapshot)}
                                                className="px-2 py-1 rounded border border-border text-foreground hover:bg-muted/70 disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                                {t.recoverySnapshotsRestore}
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </section>

            <ConfirmModal
                isOpen={snapshotToRestore !== null}
                title={t.recoverySnapshotsConfirmTitle}
                description={snapshotToRestore ? t.recoverySnapshotsConfirm.replace('{snapshot}', snapshotToRestore) : undefined}
                confirmLabel={t.recoverySnapshotsRestore}
                cancelLabel={t.recoverySnapshotsConfirmCancel}
                onCancel={() => setSnapshotToRestore(null)}
                onConfirm={() => {
                    if (!snapshotToRestore) return;
                    const nextSnapshot = snapshotToRestore;
                    setSnapshotToRestore(null);
                    void onRestoreSnapshot(nextSnapshot);
                }}
            />

            <section className="space-y-3">
                <h2 className="text-lg font-semibold flex items-center gap-2">
                    <Trash2 className="w-5 h-5" />
                    {t.attachmentsCleanup}
                </h2>
                <div className="bg-card border border-border rounded-lg p-6 space-y-3">
                    <p className="text-sm text-muted-foreground">{t.attachmentsCleanupDesc}</p>
                    <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                        <div className="text-muted-foreground">
                            {t.attachmentsCleanupLastRun}:{' '}
                            <span className="font-medium text-foreground">
                                {attachmentsLastCleanupDisplay || t.attachmentsCleanupNever}
                            </span>
                        </div>
                        <button
                            type="button"
                            onClick={onRunAttachmentsCleanup}
                            className="px-3 py-1.5 rounded-md text-xs font-medium bg-muted text-foreground hover:bg-muted/80 transition-colors"
                            disabled={!isTauri || isCleaningAttachments}
                        >
                            {isCleaningAttachments ? t.attachmentsCleanupRunning : t.attachmentsCleanupRun}
                        </button>
                    </div>
                </div>
            </section>

            {isTauri && (
                <section className="space-y-3">
                    <h2 className="text-lg font-semibold flex items-center gap-2">
                        <Info className="w-5 h-5" />
                        {t.diagnostics}
                    </h2>
                    <div className="bg-card border border-border rounded-lg p-6 space-y-4">
                        <p className="text-sm text-muted-foreground">{t.diagnosticsDesc}</p>
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <p className="text-sm font-medium">{t.debugLogging}</p>
                                <p className="text-xs text-muted-foreground">{t.debugLoggingDesc}</p>
                            </div>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={loggingEnabled}
                                onClick={onToggleLogging}
                                className={cn(
                                    "relative inline-flex h-5 w-9 items-center rounded-full border transition-colors",
                                    loggingEnabled ? "bg-primary border-primary" : "bg-muted/50 border-border"
                                )}
                            >
                                <span
                                    className={cn(
                                        "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
                                        loggingEnabled ? "translate-x-4" : "translate-x-1"
                                    )}
                                />
                            </button>
                        </div>
                        {loggingEnabled && logPath && (
                            <div className="text-xs text-muted-foreground">
                                <span className="font-medium">{t.logFile}:</span>{' '}
                                <span className="font-mono break-all">{logPath}</span>
                            </div>
                        )}
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={onClearLog}
                                className="px-3 py-1.5 rounded-md text-xs font-medium bg-muted text-foreground hover:bg-muted/80 transition-colors"
                            >
                                {t.clearLog}
                            </button>
                        </div>
                    </div>
                </section>
            )}
        </div>
    );
}
