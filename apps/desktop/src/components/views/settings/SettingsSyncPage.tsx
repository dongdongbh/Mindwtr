import type { AppData } from '@mindwtr/core';
import { Database, ExternalLink, Info, RefreshCw } from 'lucide-react';

import { cn } from '../../../lib/utils';

type Labels = {
    localData: string;
    localDataDesc: string;
    webDataDesc: string;
    diagnostics: string;
    diagnosticsDesc: string;
    debugLogging: string;
    debugLoggingDesc: string;
    logFile: string;
    clearLog: string;
    sync: string;
    syncDescription: string;
    syncBackend: string;
    syncBackendFile: string;
    syncBackendWebdav: string;
    syncBackendCloud: string;
    syncFolderLocation: string;
    savePath: string;
    browse: string;
    pathHint: string;
    webdavUrl: string;
    webdavHint: string;
    webdavUsername: string;
    webdavPassword: string;
    webdavSave: string;
    cloudUrl: string;
    cloudHint: string;
    cloudToken: string;
    cloudSave: string;
    syncNow: string;
    syncing: string;
    lastSync: string;
    lastSyncSuccess: string;
    lastSyncConflict: string;
    lastSyncError: string;
    lastSyncConflicts: string;
};

type SyncBackend = 'file' | 'webdav' | 'cloud';

type SettingsSyncPageProps = {
    t: Labels;
    isTauri: boolean;
    dataPath: string;
    dbPath: string;
    configPath: string;
    loggingEnabled: boolean;
    logPath: string;
    onToggleLogging: () => void;
    onClearLog: () => void;
    syncBackend: SyncBackend;
    onSetSyncBackend: (backend: SyncBackend) => void;
    syncPath: string;
    onSyncPathChange: (value: string) => void;
    onSaveSyncPath: () => Promise<void> | void;
    onBrowseSyncPath: () => void;
    webdavUrl: string;
    webdavUsername: string;
    webdavPassword: string;
    onWebdavUrlChange: (value: string) => void;
    onWebdavUsernameChange: (value: string) => void;
    onWebdavPasswordChange: (value: string) => void;
    onSaveWebDav: () => Promise<void> | void;
    cloudUrl: string;
    cloudToken: string;
    onCloudUrlChange: (value: string) => void;
    onCloudTokenChange: (value: string) => void;
    onSaveCloud: () => Promise<void> | void;
    onSyncNow: () => Promise<void> | void;
    isSyncing: boolean;
    syncError: string | null;
    lastSyncDisplay: string;
    lastSyncStatus: AppData['settings']['lastSyncStatus'];
    lastSyncStats: AppData['settings']['lastSyncStats'] | null;
    conflictCount: number;
    lastSyncError?: string;
};

export function SettingsSyncPage({
    t,
    isTauri,
    dataPath,
    dbPath,
    configPath,
    loggingEnabled,
    logPath,
    onToggleLogging,
    onClearLog,
    syncBackend,
    onSetSyncBackend,
    syncPath,
    onSyncPathChange,
    onSaveSyncPath,
    onBrowseSyncPath,
    webdavUrl,
    webdavUsername,
    webdavPassword,
    onWebdavUrlChange,
    onWebdavUsernameChange,
    onWebdavPasswordChange,
    onSaveWebDav,
    cloudUrl,
    cloudToken,
    onCloudUrlChange,
    onCloudTokenChange,
    onSaveCloud,
    onSyncNow,
    isSyncing,
    syncError,
    lastSyncDisplay,
    lastSyncStatus,
    lastSyncStats,
    conflictCount,
    lastSyncError,
}: SettingsSyncPageProps) {
    return (
        <div className="space-y-8">
            <section className="space-y-3">
                <h2 className="text-lg font-semibold flex items-center gap-2">
                    <Database className="w-5 h-5" />
                    {t.localData}
                </h2>
                <div className="bg-card border border-border rounded-lg p-6 space-y-3">
                    <p className="text-sm text-muted-foreground">{isTauri ? t.localDataDesc : t.webDataDesc}</p>
                    {isTauri && dataPath && (
                        <div className="space-y-2 text-sm">
                            {dbPath && (
                                <div className="flex items-center justify-between gap-4">
                                    <span className="text-muted-foreground">mindwtr.db</span>
                                    <span className="font-mono text-xs break-all">{dbPath}</span>
                                </div>
                            )}
                            <div className="flex items-center justify-between gap-4">
                                <span className="text-muted-foreground">data.json (backup)</span>
                                <span className="font-mono text-xs break-all">{dataPath}</span>
                            </div>
                            <div className="flex items-center justify-between gap-4">
                                <span className="text-muted-foreground">config.toml</span>
                                <span className="font-mono text-xs break-all">{configPath}</span>
                            </div>
                        </div>
                    )}
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
                                    className="flex-1 bg-muted p-2 rounded text-sm font-mono border border-border focus:outline-none focus:ring-2 focus:ring-blue-500"
                                />
                                <button
                                    onClick={onSaveSyncPath}
                                    disabled={!syncPath.trim() || !isTauri}
                                    className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:bg-gray-400 whitespace-nowrap"
                                >
                                    {t.savePath}
                                </button>
                                <button
                                    onClick={onBrowseSyncPath}
                                    disabled={!isTauri}
                                    className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md text-sm font-medium hover:bg-secondary/90 whitespace-nowrap disabled:opacity-50"
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
                                    className="bg-muted p-2 rounded text-sm font-mono border border-border focus:outline-none focus:ring-2 focus:ring-blue-500"
                                />
                                <p className="text-xs text-muted-foreground">{t.webdavHint}</p>
                            </div>

                            <div className="grid sm:grid-cols-2 gap-2">
                                <div className="flex flex-col gap-2">
                                    <label className="text-sm font-medium">{t.webdavUsername}</label>
                                    <input
                                        type="text"
                                        value={webdavUsername}
                                        onChange={(e) => onWebdavUsernameChange(e.target.value)}
                                        className="bg-muted p-2 rounded text-sm border border-border focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    />
                                </div>
                                <div className="flex flex-col gap-2">
                                    <label className="text-sm font-medium">{t.webdavPassword}</label>
                                    <input
                                        type="password"
                                        value={webdavPassword}
                                        onChange={(e) => onWebdavPasswordChange(e.target.value)}
                                        className="bg-muted p-2 rounded text-sm border border-border focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    />
                                </div>
                            </div>

                            <div className="flex justify-end">
                                <button
                                    onClick={onSaveWebDav}
                                    className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 whitespace-nowrap"
                                >
                                    {t.webdavSave}
                                </button>
                            </div>
                        </div>
                    )}

                    {syncBackend === 'cloud' && (
                        <div className="space-y-3">
                            <div className="flex flex-col gap-2">
                                <label className="text-sm font-medium">{t.cloudUrl}</label>
                                <input
                                    type="text"
                                    value={cloudUrl}
                                    onChange={(e) => onCloudUrlChange(e.target.value)}
                                    placeholder="https://example.com/v1/data"
                                    className="bg-muted p-2 rounded text-sm font-mono border border-border focus:outline-none focus:ring-2 focus:ring-blue-500"
                                />
                                <p className="text-xs text-muted-foreground">{t.cloudHint}</p>
                            </div>

                            <div className="flex flex-col gap-2">
                                <label className="text-sm font-medium">{t.cloudToken}</label>
                                <input
                                    type="password"
                                    value={cloudToken}
                                    onChange={(e) => onCloudTokenChange(e.target.value)}
                                    className="bg-muted p-2 rounded text-sm border border-border focus:outline-none focus:ring-2 focus:ring-blue-500"
                                />
                            </div>

                            <div className="flex justify-end">
                                <button
                                    onClick={onSaveCloud}
                                    className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 whitespace-nowrap"
                                >
                                    {t.cloudSave}
                                </button>
                            </div>
                        </div>
                    )}

                    {(syncBackend === 'webdav'
                        ? !!webdavUrl.trim()
                        : syncBackend === 'cloud'
                            ? !!cloudUrl.trim()
                            : !!syncPath.trim()) && (
                        <div className="pt-2 flex items-center gap-3">
                            <button
                                onClick={onSyncNow}
                                disabled={isSyncing}
                                className={cn(
                                    "flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium text-white transition-colors",
                                    isSyncing ? "bg-blue-400 cursor-not-allowed" : "bg-blue-600 hover:bg-blue-700",
                                )}
                            >
                                <ExternalLink className={cn("w-4 h-4", isSyncing && "animate-spin")} />
                                {isSyncing ? t.syncing : t.syncNow}
                            </button>
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
                        {lastSyncStatus === 'error' && lastSyncError && (
                            <div className="text-destructive">{lastSyncError}</div>
                        )}
                    </div>
                </div>
            </section>
        </div>
    );
}
