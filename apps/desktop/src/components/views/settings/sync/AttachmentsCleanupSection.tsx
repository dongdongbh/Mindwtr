import { useState } from 'react';
import { SettingRow, SettingsDisclosureCard } from '../SettingRow';
import type { SettingsDataPageProps } from './types';

type AttachmentsCleanupSectionProps = Pick<
    SettingsDataPageProps,
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
    const [open, setOpen] = useState(false);

    return (
        <SettingsDisclosureCard
            sectionKey="attachmentsCleanup"
            title={t.attachmentsCleanup}
            description={t.attachmentsCleanupDesc}
            open={open}
            onToggle={() => setOpen((prev) => !prev)}
        >
            <SettingRow
                settingsKey={null}
                title={t.attachmentsCleanupLastRun}
                description={attachmentsLastCleanupDisplay || t.attachmentsCleanupNever}
                className="flex-wrap"
                padded
            >
                <button
                    type="button"
                    onClick={onRunAttachmentsCleanup}
                    className="px-3 py-1.5 rounded-md text-xs font-medium bg-muted text-foreground hover:bg-muted/80 transition-colors disabled:opacity-50"
                    disabled={!isTauri || isCleaningAttachments}
                >
                    {isCleaningAttachments ? t.attachmentsCleanupRunning : t.attachmentsCleanupRun}
                </button>
            </SettingRow>
            <SettingRow
                settingsKey={null}
                title={t.attachmentsCleanupPendingDeletes}
                description={String(pendingRemoteDeleteCount)}
                className="flex-wrap"
                padded
            >
                <button
                    type="button"
                    onClick={onClearPendingRemoteDeletes}
                    className="px-3 py-1.5 rounded-md text-xs font-medium bg-muted text-foreground hover:bg-muted/80 transition-colors disabled:opacity-50"
                    disabled={pendingRemoteDeleteCount === 0}
                >
                    {t.attachmentsCleanupPendingDeletesClear}
                </button>
            </SettingRow>
        </SettingsDisclosureCard>
    );
}
