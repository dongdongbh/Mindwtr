import { useEffect, useState } from 'react';
import { Info } from 'lucide-react';
import { Switch } from '../../../ui/Switch';
import { SettingRow } from '../SettingRow';
import { getDesktopSyncEncryptionDiagnosticsLines } from '../../../../lib/sync-service';
import type { SettingsDataPageProps } from './types';

/**
 * The `Encryption` block (#1056 diagnostics). Read-only and selectable, rendered with the same
 * `label: value` tokens the `[sync-encryption]` log lines use so a user can paste either into a
 * report and the two match. Loads its own data: nothing else on the Data page needs the
 * encryption posture, and threading it through the settings props would touch four files.
 */
function SyncEncryptionDiagnostics({ title }: { title: string }) {
    const [lines, setLines] = useState<string[] | null>(null);

    useEffect(() => {
        let cancelled = false;
        void getDesktopSyncEncryptionDiagnosticsLines()
            .then((next) => {
                if (!cancelled) setLines(next);
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, []);

    if (!lines) return null;
    return (
        // Folded by default: the block is reference data for a bug report, not
        // something to read on every visit. The lines are still loaded on mount so
        // the log stamp above happens whether or not the user unfolds it.
        <details data-settings-key="syncEncryptionDiagnostics" className="text-xs text-muted-foreground">
            <summary className="font-medium mb-1 cursor-pointer select-none">{title}</summary>
            <pre className="font-mono whitespace-pre-wrap break-all select-text m-0">{lines.join('\n')}</pre>
        </details>
    );
}

type DiagnosticsSectionProps = Pick<
    SettingsDataPageProps,
    | 't'
    | 'analyticsHeartbeatAvailable'
    | 'analyticsHeartbeatEnabled'
    | 'loggingEnabled'
    | 'logPath'
    | 'onAnalyticsHeartbeatChange'
    | 'onToggleLogging'
    | 'onClearLog'
>;

export function DiagnosticsSection({
    analyticsHeartbeatAvailable,
    analyticsHeartbeatEnabled,
    logPath,
    loggingEnabled,
    onAnalyticsHeartbeatChange,
    onClearLog,
    onToggleLogging,
    t,
}: DiagnosticsSectionProps) {
    const analyticsHeartbeatOptedOut = analyticsHeartbeatAvailable && !analyticsHeartbeatEnabled;
    const toggleAnalyticsHeartbeatOptOut = () => {
        const nextOptedOut = !analyticsHeartbeatOptedOut;
        void onAnalyticsHeartbeatChange(!nextOptedOut);
    };

    return (
        <section className="space-y-3">
            <h2 data-settings-key="diagnostics" className="text-lg font-semibold flex items-center gap-2">
                <Info className="w-5 h-5" />
                {t.diagnostics}
            </h2>
            <div className="bg-card border border-border rounded-lg p-6 space-y-4">
                <p className="text-sm text-muted-foreground">{t.diagnosticsDesc}</p>
                <SyncEncryptionDiagnostics title={t.syncEncryption} />
                {analyticsHeartbeatAvailable && (
                    <SettingRow
                        settingsKey="analyticsHeartbeat"
                        title={t.analyticsHeartbeat}
                        description={t.analyticsHeartbeatDesc}
                    >
                        <Switch
                            aria-label={t.analyticsHeartbeat}
                            checked={analyticsHeartbeatOptedOut}
                            onCheckedChange={toggleAnalyticsHeartbeatOptOut}
                        />
                    </SettingRow>
                )}
                <SettingRow
                    settingsKey="debugLogging"
                    title={t.debugLogging}
                    description={t.debugLoggingDesc}
                >
                    <Switch
                        aria-label={t.debugLogging}
                        checked={loggingEnabled}
                        onCheckedChange={onToggleLogging}
                    />
                </SettingRow>
                {loggingEnabled && logPath && (
                    <div data-settings-key="logFile" className="text-xs text-muted-foreground">
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
    );
}
