import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettingsDataPage } from './useSettingsDataPage';

const storeMock = vi.hoisted(() => ({
    updateSettings: vi.fn().mockResolvedValue(undefined),
    seedGettingStarted: vi.fn().mockResolvedValue({}),
}));

vi.mock('@mindwtr/core', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@mindwtr/core')>()),
    useTaskStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
        settings: { attachments: { pendingRemoteDeletes: ['attachment-1'] } },
        updateSettings: storeMock.updateSettings,
        seedGettingStarted: storeMock.seedGettingStarted,
        tasks: [],
        projects: [],
        sections: [],
        areas: [],
    }),
}));

vi.mock('../../../store/ui-store', () => ({
    useUiStore: Object.assign(
        (selector: (state: Record<string, unknown>) => unknown) => selector({ showToast: vi.fn() }),
        { getState: () => ({ setProjectView: vi.fn() }) },
    ),
}));

vi.mock('../../../lib/analytics-heartbeat', () => ({
    isDesktopAnalyticsHeartbeatConfigured: () => false,
    resetDesktopAnalyticsOptOutMarker: vi.fn(),
    sendDesktopAnalyticsOptOut: vi.fn(),
}));

vi.mock('../../../lib/app-log', () => ({ clearLog: vi.fn() }));
vi.mock('../../../lib/report-error', () => ({ reportError: vi.fn() }));
vi.mock('../../../lib/sync-service', () => ({
    SyncService: { cleanupAttachmentsNow: vi.fn() },
}));

describe('useSettingsDataPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('uses the localized affirmative label for clearing pending attachment deletes', async () => {
        const requestConfirmation = vi.fn().mockResolvedValue(false);
        const labels = new Proxy({ attachmentsCleanupPendingDeletesConfirmAction: 'Proceed' } as Record<string, string>, {
            get: (target, key) => target[String(key)] ?? String(key),
        });
        const { result } = renderHook(() => useSettingsDataPage({
            isTauri: true,
            language: 'en',
            logPath: '',
            cancelLabel: 'Cancel',
            translate: (key) => key,
            showSaved: vi.fn(),
            requestConfirmation,
            t: labels as any,
            dataTransferProps: {
                transferAction: null,
                onExportBackup: vi.fn(),
            onExportCsv: vi.fn(),
            onExportTaskNotes: vi.fn(),
                onRestoreBackup: vi.fn(),
                onMergeBackup: vi.fn(),
                onImportTodoist: vi.fn(),
                onImportTickTick: vi.fn(),
                onImportDgt: vi.fn(),
                onImportOmniFocus: vi.fn(),
                onImportMindwtrCsv: vi.fn(),
                onImportMicrosoftTodo: vi.fn(),
            },
        }));

        await act(async () => {
            await result.current.onClearPendingRemoteDeletes();
        });

        expect(requestConfirmation).toHaveBeenCalledWith(expect.objectContaining({
            confirmLabel: 'Proceed',
        }));
    });
});
