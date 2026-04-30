import { Info } from 'lucide-react';
import { cn } from '../../../../lib/utils';
import type { SettingsSyncPageProps } from './types';

type DiagnosticsSectionProps = Pick<
    SettingsSyncPageProps,
    | 't'
    | 'loggingEnabled'
    | 'logPath'
    | 'onToggleLogging'
    | 'onClearLog'
>;

export function DiagnosticsSection({
    logPath,
    loggingEnabled,
    onClearLog,
    onToggleLogging,
    t,
}: DiagnosticsSectionProps) {
    return (
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
                            'relative inline-flex h-5 w-9 items-center rounded-full border transition-colors',
                            loggingEnabled ? 'bg-primary border-primary' : 'bg-muted/50 border-border'
                        )}
                    >
                        <span
                            className={cn(
                                'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                                loggingEnabled ? 'translate-x-4' : 'translate-x-1'
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
    );
}
