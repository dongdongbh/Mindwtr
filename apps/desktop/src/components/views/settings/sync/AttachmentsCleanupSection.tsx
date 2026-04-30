import { Trash2 } from 'lucide-react';
import type { SettingsSyncPageProps } from './types';

type AttachmentsCleanupSectionProps = Pick<
    SettingsSyncPageProps,
    | 't'
    | 'isTauri'
    | 'attachmentsLastCleanupDisplay'
    | 'pendingRemoteDeleteCount'
    | 'onClearPendingRemoteDeletes'
    | 'onRunAttachmentsCleanup'
    | 'isCleaningAttachments'
>;

export function AttachmentsCleanupSection({
    attachmentsLastCleanupDisplay,
    isCleaningAttachments,
    isTauri,
    onClearPendingRemoteDeletes,
    onRunAttachmentsCleanup,
    pendingRemoteDeleteCount,
    t,
}: AttachmentsCleanupSectionProps) {
    return (
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
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 text-sm">
                    <div className="text-muted-foreground">
                        {t.attachmentsCleanupPendingDeletes}:{' '}
                        <span className="font-medium text-foreground">{pendingRemoteDeleteCount}</span>
                    </div>
                    <button
                        type="button"
                        onClick={onClearPendingRemoteDeletes}
                        className="px-3 py-1.5 rounded-md text-xs font-medium bg-muted text-foreground hover:bg-muted/80 transition-colors disabled:opacity-50"
                        disabled={pendingRemoteDeleteCount === 0}
                    >
                        {t.attachmentsCleanupPendingDeletesClear}
                    </button>
                </div>
            </div>
        </section>
    );
}
