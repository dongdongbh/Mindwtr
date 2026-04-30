import { useState } from 'react';
import { safeFormatDate } from '@mindwtr/core';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { cn } from '../../../../lib/utils';
import { ConfirmModal } from '../../../ConfirmModal';
import { formatClockSkew } from './sync-page-utils';
import type { SettingsSyncPageProps, SyncPreferences } from './types';

type SyncStatusSectionProps = Pick<
    SettingsSyncPageProps,
    | 't'
    | 'syncPreferences'
    | 'onUpdateSyncPreferences'
    | 'onSyncNow'
    | 'isSyncing'
    | 'syncQueued'
    | 'syncLastResult'
    | 'syncLastResultAt'
    | 'syncError'
    | 'lastSyncDisplay'
    | 'lastSyncStatus'
    | 'lastSyncStats'
    | 'lastSyncHistory'
    | 'conflictCount'
    | 'lastSyncError'
    | 'snapshots'
    | 'isLoadingSnapshots'
    | 'isRestoringSnapshot'
    | 'onRestoreSnapshot'
> & {
    isSyncTargetValid: boolean;
};

function SyncPreferenceToggle({
    checked,
    hint,
    label,
    onClick,
}: {
    checked: boolean;
    hint?: string;
    label: string;
    onClick: () => void;
}) {
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
                onClick={onClick}
                className={cn(
                    'relative inline-flex h-5 w-9 items-center rounded-full border transition-colors',
                    checked ? 'bg-primary border-primary' : 'bg-muted/50 border-border',
                )}
            >
                <span
                    className={cn(
                        'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                        checked ? 'translate-x-4' : 'translate-x-1',
                    )}
                />
            </button>
        </div>
    );
}

export function SyncStatusSection({
    conflictCount,
    isLoadingSnapshots,
    isRestoringSnapshot,
    isSyncTargetValid,
    isSyncing,
    lastSyncDisplay,
    lastSyncError,
    lastSyncHistory,
    lastSyncStats,
    lastSyncStatus,
    onRestoreSnapshot,
    onSyncNow,
    onUpdateSyncPreferences,
    snapshots,
    syncError,
    syncLastResult,
    syncLastResultAt,
    syncPreferences,
    syncQueued,
    t,
}: SyncStatusSectionProps) {
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
    const [syncOptionsOpen, setSyncOptionsOpen] = useState(false);
    const [syncHistoryOpen, setSyncHistoryOpen] = useState(false);
    const [snapshotsOpen, setSnapshotsOpen] = useState(false);
    const [snapshotToRestore, setSnapshotToRestore] = useState<string | null>(null);
    const renderSyncToggle = (key: keyof SyncPreferences, label: string, hint?: string) => {
        const checked = syncPrefs[key] === true;
        return (
            <SyncPreferenceToggle
                checked={checked}
                label={label}
                hint={hint}
                onClick={() => onUpdateSyncPreferences({ [key]: !checked } as Partial<SyncPreferences>)}
            />
        );
    };

    return (
        <section className="space-y-3">
            <h2 className="text-lg font-semibold flex items-center gap-2">
                <RefreshCw className="w-5 h-5" />
                {t.syncPreferences}
            </h2>
            <div className="bg-card border border-border rounded-lg p-6 space-y-4">
                <div className="space-y-3">
                    <button
                        type="button"
                        onClick={() => setSyncOptionsOpen((prev) => !prev)}
                        aria-expanded={syncOptionsOpen}
                        className="w-full flex items-start justify-between gap-4 text-left"
                    >
                        <div>
                            <div className="text-sm font-medium">{t.syncPreferences}</div>
                            <p className="text-xs text-muted-foreground">{t.syncPreferencesDesc}</p>
                        </div>
                        {syncOptionsOpen ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
                    </button>
                    {syncOptionsOpen && (
                        <div className="space-y-3">
                            {renderSyncToggle('appearance', t.syncPreferenceAppearance)}
                            {renderSyncToggle('language', t.syncPreferenceLanguage)}
                            {renderSyncToggle('gtd', t.syncPreferenceGtd)}
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
                                'flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium text-primary-foreground transition-colors',
                                isSyncing ? 'bg-muted text-muted-foreground cursor-not-allowed' : 'bg-primary hover:bg-primary/90',
                            )}
                        >
                            <RefreshCw className={cn('w-4 h-4', isSyncing && 'animate-spin')} />
                            {isSyncing ? t.syncing : t.syncNow}
                        </button>
                        {syncStatusLabel && (
                            <span className={cn('text-xs', syncStatusTone)}>
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
                                {syncHistoryOpen ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
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
                            {snapshotsOpen ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
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
        </section>
    );
}
