import { useEffect, useMemo, useState } from 'react';
import {
    isSettingsSyncGroupEnabled,
    listMergeConflictSamples,
    safeFormatDate,
    summarizeMergeStats,
    useTaskStore,
} from '@mindwtr/core';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { useConfirmDialog } from '../../../../hooks/useConfirmDialog';
import { cn } from '../../../../lib/utils';
import { Switch } from '../../../ui/Switch';
import { formatClockSkew } from './sync-page-utils';
import { SettingRow } from '../SettingRow';
import type { SettingsSyncPageProps, SyncPreferences } from './types';

const RECENT_SYNC_RESULT_MS = 8000;

type SyncStatusSectionProps = Pick<
    SettingsSyncPageProps,
    | 't'
    | 'isSyncTargetValid'
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
>;

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
    const lastSyncSummary = summarizeMergeStats(lastSyncStats);
    const maxClockSkewMs = lastSyncSummary.maxClockSkewMs;
    const timestampAdjustments = lastSyncSummary.timestampAdjustments;
    const conflictIds = lastSyncSummary.conflictIds.slice(0, 6);
    const conflictSamples = useMemo(() => listMergeConflictSamples(lastSyncStats).slice(0, 6), [lastSyncStats]);
    const allTasks = useTaskStore((state) => state._allTasks);
    const allProjects = useTaskStore((state) => state._allProjects);
    const allSections = useTaskStore((state) => state._allSections);
    const allAreas = useTaskStore((state) => state._allAreas);
    const allPeople = useTaskStore((state) => state._allPeople);
    const conflictTitleById = useMemo(() => {
        const titles = new Map<string, string>();
        if (conflictSamples.length === 0) return titles;
        for (const sample of conflictSamples) {
            const { id } = sample;
            const entity = sample.entity === 'task'
                ? allTasks.find((item) => item.id === id)
                : sample.entity === 'project'
                    ? allProjects.find((item) => item.id === id)
                    : sample.entity === 'section'
                        ? allSections.find((item) => item.id === id)
                        : sample.entity === 'area'
                            ? allAreas.find((item) => item.id === id)
                            : allPeople.find((item) => item.id === id);
            if (!entity) continue;
            const title = 'title' in entity ? entity.title : entity.name;
            if (title) titles.set(id, title);
        }
        return titles;
    }, [conflictSamples, allTasks, allProjects, allSections, allAreas, allPeople]);
    const describeConflictSample = (sample: (typeof conflictSamples)[number]): string => {
        const title = conflictTitleById.get(sample.id) ?? sample.id;
        const outcome = sample.winner === 'incoming' ? t.syncConflictKeptOtherDevice : t.syncConflictKeptThisDevice;
        const detail = sample.reasons.includes('deleteState')
            ? t.syncConflictDeleteRestore
            : sample.diffKeys.length > 0
                ? t.syncConflictChanged.replace('{{fields}}', sample.diffKeys.join(', '))
                : '';
        return detail ? `“${title}” — ${outcome} (${detail})` : `“${title}” — ${outcome}`;
    };
    const historyEntries = (lastSyncHistory ?? []).slice(0, 6);
    const syncPrefs = syncPreferences ?? {};
    const [recentResultNow, setRecentResultNow] = useState(Date.now);
    useEffect(() => {
        if (!syncLastResultAt || !syncLastResult) return;
        const timestamp = Date.parse(syncLastResultAt);
        if (!Number.isFinite(timestamp)) return;
        const remaining = timestamp + RECENT_SYNC_RESULT_MS - Date.now();
        if (remaining < 0) {
            setRecentResultNow(Date.now());
            return;
        }
        const timer = window.setTimeout(() => setRecentResultNow(Date.now()), remaining + 1);
        return () => window.clearTimeout(timer);
    }, [syncLastResult, syncLastResultAt]);
    const recentResultLabel = (() => {
        if (!syncLastResultAt || !syncLastResult) return null;
        const timestamp = Date.parse(syncLastResultAt);
        if (!Number.isFinite(timestamp)) return null;
        if (recentResultNow - timestamp > RECENT_SYNC_RESULT_MS) return null;
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
        const match = fileName.match(/^data\.(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:\.\d{9}(?:\.\d+)?)?\.snapshot\.json$/);
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
    const { requestConfirmation, confirmModal } = useConfirmDialog();
    const handleRestoreSnapshot = async (snapshot: string) => {
        const confirmed = await requestConfirmation({
            title: t.recoverySnapshotsConfirmTitle,
            description: t.recoverySnapshotsConfirm.replace('{snapshot}', snapshot),
            confirmLabel: t.recoverySnapshotsRestore,
            cancelLabel: t.recoverySnapshotsConfirmCancel,
        });
        if (!confirmed) return;
        void onRestoreSnapshot(snapshot);
    };
    const renderSyncToggle = (key: keyof SyncPreferences, label: string, hint?: string) => {
        const checked = isSettingsSyncGroupEnabled(syncPrefs, key);
        return (
            // Which categories sync is one control per SyncPreferences field, not
            // a setting people search for by name, so these rows stay unindexed.
            <SettingRow settingsKey={null} title={label} description={hint}>
                <Switch
                    aria-label={label}
                    checked={checked}
                    onCheckedChange={() => onUpdateSyncPreferences({ [key]: !checked } as Partial<SyncPreferences>)}
                />
            </SettingRow>
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
                    <button data-settings-key="syncPreferences"
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
                            {renderSyncToggle('savedFilters', t.syncPreferenceSavedFilters)}
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

                <SettingRow
                    settingsKey="backgroundSync"
                    title={t.backgroundSync}
                    description={t.backgroundSyncDesc}
                    className="pt-2"
                />

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
                    {lastSyncStats && conflictSamples.length > 0 && (
                        <div className="space-y-0.5">
                            {conflictSamples.map((sample) => (
                                <div key={`${sample.entity}-${sample.id}`} className="break-words">
                                    {describeConflictSample(sample)}
                                </div>
                            ))}
                            {lastSyncSummary.conflicts > conflictSamples.length && (
                                <div>
                                    {t.syncConflictMore.replace('{{count}}', String(lastSyncSummary.conflicts - conflictSamples.length))}
                                </div>
                            )}
                        </div>
                    )}
                    {lastSyncStats && conflictSamples.length === 0 && conflictIds.length > 0 && (
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
                            <button data-settings-key="syncHistory"
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
                                            entry.backend ? `${t.syncHistoryBackend}: ${entry.backend}` : null,
                                            entry.type ? `${t.syncHistoryType}: ${entry.type}` : null,
                                            entry.conflicts ? `${t.lastSyncConflicts}: ${entry.conflicts}` : null,
                                            entry.maxClockSkewMs > 0 ? `${t.lastSyncSkew}: ${formatClockSkew(entry.maxClockSkewMs)}` : null,
                                            entry.timestampAdjustments > 0 ? `${t.lastSyncAdjusted}: ${entry.timestampAdjustments}` : null,
                                            entry.details ? `${t.syncHistoryDetails}: ${entry.details}` : null,
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
                        <button data-settings-key="recoverySnapshots"
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
                                {!isLoadingSnapshots && snapshots.slice(0, 5).map((snapshot) => {
                                    const displayLabel = formatSnapshotLabel(snapshot);
                                    const accessibilityName = displayLabel === snapshot
                                        ? snapshot
                                        : `${displayLabel} (${snapshot})`;
                                    const restoreLabel = t.recoverySnapshotsRestoreNamed
                                        .replace('{{snapshotName}}', accessibilityName)
                                        .replace('{snapshotName}', accessibilityName);
                                    return (
                                        <div key={snapshot} className="flex items-center justify-between gap-2 text-xs">
                                            <span className="text-muted-foreground font-mono truncate">{displayLabel}</span>
                                            <button
                                                type="button"
                                                aria-label={restoreLabel}
                                                disabled={isRestoringSnapshot || isSyncing}
                                                onClick={() => void handleRestoreSnapshot(snapshot)}
                                                className="px-2 py-1 rounded border border-border text-foreground hover:bg-muted/70 disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                                {t.recoverySnapshotsRestore}
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {confirmModal}
        </section>
    );
}
