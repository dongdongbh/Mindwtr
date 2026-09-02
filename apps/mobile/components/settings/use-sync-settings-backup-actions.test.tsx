import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const appLogMocks = vi.hoisted(() => ({
    clearLog: vi.fn(),
    ensureLogFilePath: vi.fn(),
    logInfo: vi.fn(),
}));

const sharingMocks = vi.hoisted(() => ({
    isAvailableAsync: vi.fn(),
    shareAsync: vi.fn(),
}));

const coreMocks = vi.hoisted(() => ({
    getInMemoryAppDataSnapshot: vi.fn(),
}));

vi.mock('@mindwtr/core', async (importOriginal) => ({
    ...await importOriginal<typeof import('@mindwtr/core')>(),
    getInMemoryAppDataSnapshot: coreMocks.getInMemoryAppDataSnapshot,
}));

vi.mock('react-native', () => ({
    Alert: { alert: vi.fn() },
}));

vi.mock('expo-constants', () => ({
    default: { expoConfig: { extra: {} } },
}));

vi.mock('expo-sharing', () => sharingMocks);

vi.mock('@/lib/app-log', () => appLogMocks);

vi.mock('@/lib/settings-utils', () => ({
    logSettingsError: vi.fn(),
}));

vi.mock('@/lib/data-transfer', () => ({
    exportCurrentDataBackup: vi.fn(),
    importDgtData: vi.fn(),
    importMindwtrCsvData: vi.fn(),
    importOmniFocusData: vi.fn(),
    importTickTickData: vi.fn(),
    importTodoistData: vi.fn(),
    inspectBackupDocument: vi.fn(),
    inspectDgtDocument: vi.fn(),
    inspectMindwtrCsvDocument: vi.fn(),
    inspectOmniFocusDocument: vi.fn(),
    inspectTickTickDocument: vi.fn(),
    inspectTodoistDocument: vi.fn(),
    mergeDataFromBackup: vi.fn(),
    pickBackupDocument: vi.fn(),
    pickDgtDocument: vi.fn(),
    pickMindwtrCsvDocument: vi.fn(),
    pickOmniFocusDocument: vi.fn(),
    pickTickTickDocument: vi.fn(),
    pickTodoistDocument: vi.fn(),
    restoreDataFromBackup: vi.fn(),
    restoreLocalDataSnapshot: vi.fn(),
}));

import { Alert } from 'react-native';
import { BackupSourceFileError } from '@mindwtr/core';

import * as dataTransfer from '@/lib/data-transfer';
import { useSyncSettingsBackupActions } from './use-sync-settings-backup-actions';

type HookResult = ReturnType<typeof useSyncSettingsBackupActions>;

describe('useSyncSettingsBackupActions', () => {
    let latest: HookResult | null = null;
    const showToast = vi.fn();
    const showSettingsErrorToast = vi.fn();
    const showSettingsWarning = vi.fn();
    const setBackupAction = vi.fn();

    function Harness() {
        latest = useSyncSettingsBackupActions({
            refreshRecoverySnapshots: vi.fn(),
            settings: {},
            setBackupAction,
            showSettingsErrorToast,
            showSettingsWarning,
            showToast,
            t: (key: string) => key,
            tr: (key: string) => key,
            updateSettings: vi.fn().mockResolvedValue(undefined),
        });
        return null;
    }

    beforeEach(() => {
        vi.clearAllMocks();
        latest = null;
        appLogMocks.ensureLogFilePath.mockResolvedValue('file://logs/mindwtr.log');
        sharingMocks.isAvailableAsync.mockResolvedValue(true);
        sharingMocks.shareAsync.mockResolvedValue(undefined);
        coreMocks.getInMemoryAppDataSnapshot.mockReturnValue({
            tasks: [], projects: [], sections: [], areas: [], people: [], settings: {},
        });
    });

    it.each([
        ['handleImportTodoist', 'import:todoist'],
        ['handleImportTickTick', 'import:ticktick'],
        ['handleImportDgt', 'import:dgt'],
        ['handleImportOmniFocus', 'import:omnifocus'],
        ['handleImportMindwtrCsv', 'import:mindwtr-csv'],
    ] as const)('tracks and clears the exact operation for %s cancellation', async (handlerName, action) => {
        await act(async () => {
            create(<Harness />);
        });

        await latest?.[handlerName]();

        expect(setBackupAction.mock.calls).toEqual([[action], [null]]);
    });

    it('tracks the exact recovery snapshot through confirmation', async () => {
        vi.mocked(dataTransfer.restoreLocalDataSnapshot).mockResolvedValue(undefined);
        await act(async () => {
            create(<Harness />);
        });

        await latest?.handleRestoreRecoverySnapshot('data.second.snapshot.json');
        const [, , buttons] = vi.mocked(Alert.alert).mock.calls[0] as [string, string, Array<{ onPress?: () => Promise<void> }>];
        await act(async () => {
            await buttons[1].onPress?.();
        });

        expect(setBackupAction.mock.calls).toEqual([
            ['snapshot:data.second.snapshot.json'],
            [null],
        ]);
    });

    it('formats collision-safe recovery snapshot names as dates', async () => {
        await act(async () => {
            create(<Harness />);
        });

        const snapshotName = 'data.2026-08-09T12-34-05.123.1.snapshot.json';
        expect(latest?.formatRecoverySnapshotLabel(snapshotName)).not.toBe(snapshotName);
        expect(latest?.formatRecoverySnapshotLabel('unrecognized.snapshot.json')).toBe('unrecognized.snapshot.json');
    });

    it('exports the authoritative in-memory snapshot at press time', async () => {
        const snapshot = {
            tasks: [{ id: 'deleted-task', deleted: true, attachments: [{ id: 'deleted-file', deleted: true }] }],
            projects: [],
            sections: [],
            areas: [],
            people: [{ id: 'person-1', name: 'Ada' }],
            settings: { theme: 'dark' },
        };
        coreMocks.getInMemoryAppDataSnapshot.mockReturnValue(snapshot);

        await act(async () => {
            create(<Harness />);
        });
        await latest?.handleBackup();

        expect(coreMocks.getInMemoryAppDataSnapshot).toHaveBeenCalledTimes(1);
        expect(dataTransfer.exportCurrentDataBackup).toHaveBeenCalledWith(snapshot);
    });

    it('shows a warning instead of rejecting when Expo Go sharing fails', async () => {
        sharingMocks.isAvailableAsync.mockRejectedValue(new TypeError("Cannot read property 'replace' of undefined"));

        await act(async () => {
            create(<Harness />);
        });

        await expect(latest?.handleShareLog()).resolves.toBeUndefined();
        expect(showToast).toHaveBeenCalledWith({
            title: 'settings.debugLogging',
            message: 'settings.shareUnavailable',
            tone: 'warning',
        });
        expect(showSettingsErrorToast).not.toHaveBeenCalled();
    });

    it('shares the diagnostics log when sharing is available', async () => {
        await act(async () => {
            create(<Harness />);
        });

        await latest?.handleShareLog();

        expect(sharingMocks.shareAsync).toHaveBeenCalledWith('file://logs/mindwtr.log', { mimeType: 'text/plain' });
        expect(showToast).not.toHaveBeenCalled();
    });

    it('waits for the encryption posture line to reach the log file before sharing it', async () => {
        // `Share log` shares the log FILE. A fire-and-forget stamp races the share sheet and
        // the posture can miss the copy the user hands over (#1056 diagnostics review).
        let releaseWrite: (() => void) | undefined;
        appLogMocks.logInfo.mockImplementation(() => new Promise<null>((resolve) => {
            releaseWrite = () => resolve(null);
        }));

        await act(async () => {
            create(<Harness />);
        });

        const shared = latest!.handleShareLog();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(appLogMocks.logInfo).toHaveBeenCalledWith(
            expect.stringContaining('[sync-encryption]'),
            expect.anything(),
        );
        expect(sharingMocks.shareAsync).not.toHaveBeenCalled();

        releaseWrite?.();
        await shared;

        expect(sharingMocks.shareAsync).toHaveBeenCalledWith('file://logs/mindwtr.log', { mimeType: 'text/plain' });
    });

    it('merges a backup only after the confirmation is accepted, and reports what changed', async () => {
        const backupData = { tasks: [], projects: [], sections: [], areas: [], settings: {} };
        vi.mocked(dataTransfer.pickBackupDocument).mockResolvedValue({ uri: 'file://backup.json', fileName: 'backup.json' });
        vi.mocked(dataTransfer.inspectBackupDocument).mockResolvedValue({
            valid: true,
            data: backupData,
            errors: [],
            warnings: [],
            metadata: { taskCount: 3, projectCount: 1, sectionCount: 0, areaCount: 0 },
        } as unknown as Awaited<ReturnType<typeof dataTransfer.inspectBackupDocument>>);
        vi.mocked(dataTransfer.mergeDataFromBackup).mockResolvedValue({
            snapshotName: 'data.snapshot.json',
            result: { stats: { tasks: { incomingOnly: 2, resolvedUsingIncoming: 3 } } },
        } as unknown as Awaited<ReturnType<typeof dataTransfer.mergeDataFromBackup>>);

        await act(async () => {
            create(<Harness />);
        });
        await latest?.handleMergeBackup();

        // Nothing is written until the user accepts the confirmation.
        expect(dataTransfer.mergeDataFromBackup).not.toHaveBeenCalled();
        const [title, , buttons] = vi.mocked(Alert.alert).mock.calls[0] as [string, string, Array<{ onPress?: () => void }>];
        expect(title).toBe('settings.mergeBackup');

        await act(async () => {
            buttons[1].onPress?.();
        });

        expect(dataTransfer.mergeDataFromBackup).toHaveBeenCalledWith(backupData);
        expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
            title: 'settings.mergeBackup',
            tone: 'success',
        }));
        expect(dataTransfer.restoreDataFromBackup).not.toHaveBeenCalled();
    });

    it('exports CSV through the shared export path', async () => {
        await act(async () => {
            create(<Harness />);
        });
        await latest?.handleExportCsv();

        expect(dataTransfer.exportCurrentDataBackup).toHaveBeenCalledWith(expect.anything(), 'csv');
    });

    // D3: restore shipped without the undo action every other result path got, while the
    // release note already promised it.
    it('offers Undo on a restore result too', async () => {
        vi.mocked(dataTransfer.pickBackupDocument).mockResolvedValue({ uri: 'file://backup.json', fileName: 'backup.json' });
        vi.mocked(dataTransfer.inspectBackupDocument).mockResolvedValue({
            valid: true,
            data: { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} },
            errors: [],
            warnings: [],
            metadata: { taskCount: 0, projectCount: 0, sectionCount: 0, areaCount: 0 },
        } as never);
        vi.mocked(dataTransfer.restoreDataFromBackup).mockResolvedValue({
            snapshotName: 'data.2026-08-13T10-00-00.000.snapshot.json',
        } as never);

        await act(async () => { create(<Harness />); });
        await latest?.handleRestoreBackup();
        const [, , buttons] = vi.mocked(Alert.alert).mock.calls[0] as [string, string, Array<{ onPress?: () => void }>];
        await act(async () => { buttons[1].onPress?.(); });

        const toast = showToast.mock.calls[showToast.mock.calls.length - 1]?.[0];
        expect(toast.actionLabel).toBe('settings.undoImport');

        vi.mocked(Alert.alert).mockClear();
        await act(async () => { await toast.onAction?.(); });
        const [, , undoButtons] = vi.mocked(Alert.alert).mock.calls[0] as [string, string, Array<{ onPress?: () => void }>];
        await act(async () => { await undoButtons[1].onPress?.(); });

        expect(dataTransfer.restoreLocalDataSnapshot).toHaveBeenCalledWith('data.2026-08-13T10-00-00.000.snapshot.json');
    });

    // #Q-03: the result toast carries the rollback, so it dies with the message
    // instead of leaving a persistent affordance.
    it('offers Undo import on the result and restores that exact snapshot', async () => {
        vi.mocked(dataTransfer.pickBackupDocument).mockResolvedValue({ uri: 'file://backup.json', fileName: 'backup.json' });
        vi.mocked(dataTransfer.inspectBackupDocument).mockResolvedValue({
            valid: true,
            data: { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} },
            errors: [],
            warnings: [],
            metadata: { taskCount: 0, projectCount: 0, sectionCount: 0, areaCount: 0 },
        } as never);
        vi.mocked(dataTransfer.mergeDataFromBackup).mockResolvedValue({
            snapshotName: 'data.2026-08-13T10-00-00.000.snapshot.json',
            result: { stats: { tasks: { incomingOnly: 0, resolvedUsingIncoming: 0 } } },
        } as never);

        await act(async () => {
            create(<Harness />);
        });
        await latest?.handleMergeBackup();
        const [, , confirmButtons] = vi.mocked(Alert.alert).mock.calls[0] as [string, string, Array<{ onPress?: () => void }>];
        await act(async () => { confirmButtons[1].onPress?.(); });

        const toast = showToast.mock.calls.at(-1)?.[0];
        expect(toast.actionLabel).toBe('settings.undoImport');

        vi.mocked(Alert.alert).mockClear();
        await act(async () => { await toast.onAction?.(); });

        // Same destructive confirmation as a manual snapshot restore.
        const [undoTitle, , undoButtons] = vi.mocked(Alert.alert).mock.calls[0] as [string, string, Array<{ onPress?: () => void }>];
        expect(undoTitle).toBe('settings.undoImportConfirmTitle');
        expect(dataTransfer.restoreLocalDataSnapshot).not.toHaveBeenCalled();

        await act(async () => { await undoButtons[1].onPress?.(); });
        expect(dataTransfer.restoreLocalDataSnapshot).toHaveBeenCalledWith('data.2026-08-13T10-00-00.000.snapshot.json');
    });

    it('renders structured backup warnings through the active locale', async () => {
        vi.mocked(dataTransfer.pickBackupDocument).mockResolvedValue({ uri: 'file://backup.json', fileName: 'backup.json' });
        vi.mocked(dataTransfer.inspectBackupDocument).mockResolvedValue({
            valid: true,
            data: { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} },
            errors: [],
            warnings: ['raw newer-version warning'],
            diagnostics: [{
                code: 'backup-newer-version',
                params: { version: '2.0.0' },
                severity: 'warning',
            }],
            metadata: { taskCount: 0, projectCount: 0, sectionCount: 0, areaCount: 0 },
        } as Awaited<ReturnType<typeof dataTransfer.inspectBackupDocument>>);

        await act(async () => {
            create(<Harness />);
        });
        await latest?.handleRestoreBackup();

        expect(vi.mocked(Alert.alert).mock.calls[0]?.[1]).toContain('settings.backupDiagnostics.newerVersion');
        expect(vi.mocked(Alert.alert).mock.calls[0]?.[1]).not.toContain('raw newer-version warning');
    });

    it('localizes a structured oversized-backup error', async () => {
        vi.mocked(dataTransfer.pickBackupDocument).mockResolvedValue({ uri: 'file://backup.json', fileName: 'backup.json' });
        vi.mocked(dataTransfer.inspectBackupDocument).mockRejectedValue(new BackupSourceFileError(
            'backup-source-too-large',
            'raw oversized error',
            { maxSizeMb: 128 },
        ));

        await act(async () => {
            create(<Harness />);
        });
        await latest?.handleRestoreBackup();

        expect(showSettingsErrorToast).toHaveBeenCalledWith(
            'settings.backupMobile.restoreFailed',
            'settings.backupDiagnostics.tooLarge',
            5200,
        );
    });

    it('uses the active locale for an unknown backup size', async () => {
        function LocalizedHarness() {
            latest = useSyncSettingsBackupActions({
                refreshRecoverySnapshots: vi.fn(),
                settings: {},
                setBackupAction: vi.fn(),
                showSettingsErrorToast,
                showSettingsWarning,
                showToast,
                t: (key: string) => key,
                tr: (key: string) => key === 'settings.backupDiagnostics.unknownSize'
                    ? 'Impossible de vérifier la taille de la sauvegarde.'
                    : key,
                updateSettings: vi.fn().mockResolvedValue(undefined),
            });
            return null;
        }
        vi.mocked(dataTransfer.pickBackupDocument).mockResolvedValue({ uri: 'file://backup.json', fileName: 'backup.json' });
        vi.mocked(dataTransfer.inspectBackupDocument).mockRejectedValue(new BackupSourceFileError(
            'backup-source-size-unknown',
            'raw English error',
        ));

        await act(async () => {
            create(<LocalizedHarness />);
        });
        await latest?.handleRestoreBackup();

        expect(showSettingsErrorToast).toHaveBeenCalledWith(
            'settings.backupMobile.restoreFailed',
            'Impossible de vérifier la taille de la sauvegarde.',
            5200,
        );
    });
});
