import { useCallback, useMemo, useState } from 'react';
import { safeFormatDate, useTaskStore, type AppData } from '@mindwtr/core';

import { clearLog, saveLogCopy } from '../../../lib/app-log';
import {
    isDesktopAnalyticsHeartbeatConfigured,
    resetDesktopAnalyticsOptOutMarker,
    sendDesktopAnalyticsOptOut,
} from '../../../lib/analytics-heartbeat';
import { reportError } from '../../../lib/report-error';
import { SyncService } from '../../../lib/sync-service';
import { useUiStore } from '../../../store/ui-store';
import type { ConfirmationRequestOptions } from '../../../hooks/useConfirmDialog';
import type { Language } from '../../../contexts/language-context';
import type { SettingsLabels } from './labels';
import type { SettingsDataPageProps, SettingsDataTransferProps } from './sync/types';

type UseSettingsDataPageOptions = {
    isTauri: boolean;
    language: Language;
    logPath: string;
    cancelLabel: string;
    translate: (key: string) => string;
    showSaved: () => void;
    requestConfirmation: (options: ConfirmationRequestOptions) => Promise<boolean>;
    t: Pick<
        SettingsLabels,
        | 'analyticsHeartbeatDisableTitle'
        | 'analyticsHeartbeatDisableDesc'
        | 'analyticsHeartbeatDisableConfirm'
        | 'analyticsHeartbeatKeepEnabled'
        | 'attachmentsCleanupPendingDeletesConfirm'
        | 'attachmentsCleanupPendingDeletesConfirmAction'
        | 'attachmentsCleanupPendingDeletesConfirmTitle'
        | 'gettingStartedContentConfirm'
        | 'gettingStartedContentConfirmDesc'
        | 'gettingStartedContentConfirmTitle'
    >;

    dataTransferProps: SettingsDataTransferProps;
};


export function useSettingsDataPage({
    isTauri,
    language,
    logPath,
    cancelLabel,
    translate,
    showSaved,
    requestConfirmation,
    t,
    dataTransferProps,
}: UseSettingsDataPageOptions): Omit<SettingsDataPageProps, 't'> {
    const [isCleaningAttachments, setIsCleaningAttachments] = useState(false);
    const settings =
        useTaskStore((state) => state.settings) ?? ({} as AppData['settings']);
    const updateSettings = useTaskStore((state) => state.updateSettings);
    const seedGettingStarted = useTaskStore((state) => state.seedGettingStarted);
    const visibleDataCount = useTaskStore((state) => (
        state.tasks.length + state.projects.length + state.sections.length + state.areas.length
    ));
    const showToast = useUiStore((state) => state.showToast);

    const loggingEnabled = settings?.diagnostics?.loggingEnabled === true;
    const analyticsHeartbeatAvailable = isDesktopAnalyticsHeartbeatConfigured();
    const analyticsHeartbeatEnabled =
        analyticsHeartbeatAvailable && settings?.analytics?.heartbeatEnabled !== false;
    const attachmentsLastCleanupAt = settings?.attachments?.lastCleanupAt;
    const pendingRemoteDeleteCount =
        settings?.attachments?.pendingRemoteDeletes?.length ?? 0;

    const attachmentsLastCleanupDisplay = useMemo(() => {
        if (!attachmentsLastCleanupAt) return '';
        return safeFormatDate(attachmentsLastCleanupAt, 'Pp');
    }, [attachmentsLastCleanupAt]);

    const onToggleLogging = useCallback(async () => {
        const nextEnabled = !loggingEnabled;
        await updateSettings({
            diagnostics: {
                ...(settings?.diagnostics ?? {}),
                loggingEnabled: nextEnabled,
            },
        })
            .then(showSaved)
            .catch((error) =>
                reportError('Failed to update logging settings', error),
            );
    }, [loggingEnabled, settings?.diagnostics, showSaved, updateSettings]);

    const onAnalyticsHeartbeatChange = useCallback(async (enabled: boolean) => {
        if (!analyticsHeartbeatAvailable) return;
        if (!enabled) {
            const confirmed = await requestConfirmation({
                title: t.analyticsHeartbeatDisableTitle,
                description: t.analyticsHeartbeatDisableDesc,
                confirmLabel: t.analyticsHeartbeatDisableConfirm,
                cancelLabel: t.analyticsHeartbeatKeepEnabled,
            });
            if (!confirmed) return;
        }

        await updateSettings({
            analytics: {
                ...(settings?.analytics ?? {}),
                heartbeatEnabled: enabled,
            },
        })
            .then(async () => {
                if (enabled) {
                    await resetDesktopAnalyticsOptOutMarker();
                    return;
                }
                await sendDesktopAnalyticsOptOut();
            })
            .then(showSaved)
            .catch((error) =>
                reportError('Failed to update analytics heartbeat setting', error),
            );
    }, [
        analyticsHeartbeatAvailable,
        requestConfirmation,
        settings?.analytics,
        showSaved,
        t.analyticsHeartbeatDisableConfirm,
        t.analyticsHeartbeatDisableDesc,
        t.analyticsHeartbeatDisableTitle,
        t.analyticsHeartbeatKeepEnabled,
        updateSettings,
    ]);

    const onClearLog = useCallback(async () => {
        await clearLog();
        showSaved();
    }, [showSaved]);

    const onSaveLog = useCallback(async () => {
        try {
            const result = await saveLogCopy();
            if (result === 'saved') showSaved();
            else if (result === 'missing') showToast(translate('settings.logMissing'), 'info');
        } catch (error) {
            reportError('Failed to save a copy of the log', error);
        }
    }, [showSaved, showToast, translate]);

    const onRunAttachmentsCleanup = useCallback(async () => {
        if (!isTauri) return;
        try {
            setIsCleaningAttachments(true);
            await SyncService.cleanupAttachmentsNow();
        } catch (error) {
            reportError('Attachment cleanup failed', error);
        } finally {
            setIsCleaningAttachments(false);
        }
    }, [isTauri]);

    const onClearPendingRemoteDeletes = useCallback(async () => {
        if (pendingRemoteDeleteCount === 0) return;
        const confirmed = await requestConfirmation({
            title: t.attachmentsCleanupPendingDeletesConfirmTitle,
            description: t.attachmentsCleanupPendingDeletesConfirm,
            confirmLabel: t.attachmentsCleanupPendingDeletesConfirmAction,
            cancelLabel,
        });
        if (!confirmed) return;
        await updateSettings({
            attachments: {
                ...(settings?.attachments ?? {}),
                pendingRemoteDeletes: undefined,
            },
        })
            .then(showSaved)
            .catch((error) =>
                reportError('Failed to clear pending attachment deletes', error),
            );
    }, [
        cancelLabel,
        pendingRemoteDeleteCount,
        requestConfirmation,
        settings?.attachments,
        showSaved,
        t.attachmentsCleanupPendingDeletesConfirm,
        t.attachmentsCleanupPendingDeletesConfirmAction,
        t.attachmentsCleanupPendingDeletesConfirmTitle,
        updateSettings,
    ]);

    const onAddGettingStartedContent = useCallback(async () => {
        if (visibleDataCount > 0) {
            const confirmed = await requestConfirmation({
                title: t.gettingStartedContentConfirmTitle,
                description: t.gettingStartedContentConfirmDesc,
                confirmLabel: t.gettingStartedContentConfirm,
                cancelLabel,
            });
            if (!confirmed) return;
        }

        try {
            const result = await seedGettingStarted({ language });
            if (result.id) {
                useUiStore.getState().setProjectView({ selectedProjectId: result.id });
                showToast(translate('onboarding.toastReady'), 'success');
                return;
            }
            showToast(translate('onboarding.toastNotCreated'), 'info');
        } catch (error) {
            showToast(translate('onboarding.toastFailed'), 'error');
            reportError('Failed to add Getting Started content', error);
        }
    }, [
        cancelLabel,
        language,
        requestConfirmation,
        seedGettingStarted,
        showToast,
        t.gettingStartedContentConfirm,
        t.gettingStartedContentConfirmDesc,
        t.gettingStartedContentConfirmTitle,
        translate,
        visibleDataCount,
    ]);

    return {
        isTauri,
        loggingEnabled,
        analyticsHeartbeatAvailable,
        analyticsHeartbeatEnabled,
        logPath,
        onToggleLogging,
        onAnalyticsHeartbeatChange,
        onClearLog,
        onSaveLog,
        ...dataTransferProps,
        attachmentsLastCleanupDisplay,
        pendingRemoteDeleteCount,
        onClearPendingRemoteDeletes,
        onRunAttachmentsCleanup,
        isCleaningAttachments,
        onAddGettingStartedContent,
    };
}
