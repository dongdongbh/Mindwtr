import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';


vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.3.4', extra: {} } } }));
vi.mock('expo-sharing', () => ({ isAvailableAsync: vi.fn(), shareAsync: vi.fn() }));
vi.mock('@/lib/app-log', () => ({ clearLog: vi.fn(), ensureLogFilePath: vi.fn(), logInfo: vi.fn() }));
vi.mock('@/lib/settings-utils', () => ({ logSettingsError: vi.fn() }));
vi.mock('@/lib/sync-encryption-state', () => ({ logSyncEncryptionDiagnosticsBlock: vi.fn() }));
vi.mock('@/lib/data-transfer', () => ({
    exportCurrentDataBackup: vi.fn(), importDgtData: vi.fn(), importMindwtrCsvData: vi.fn(), importOmniFocusData: vi.fn(),
    importTickTickData: vi.fn(), importTodoistData: vi.fn(), inspectBackupDocument: vi.fn(), inspectDgtDocument: vi.fn(),
    inspectMindwtrCsvDocument: vi.fn(), inspectOmniFocusDocument: vi.fn(), inspectTickTickDocument: vi.fn(),
    inspectTodoistDocument: vi.fn(), mergeDataFromBackup: vi.fn(), pickBackupDocument: vi.fn(), pickDgtDocument: vi.fn(),
    pickMindwtrCsvDocument: vi.fn(), pickOmniFocusDocument: vi.fn(), pickTickTickDocument: vi.fn(), pickTodoistDocument: vi.fn(),
    restoreDataFromBackup: vi.fn(), restoreLocalDataSnapshot: vi.fn(),
}));

import { Alert } from 'react-native';
import { getTranslator, resolveI18nText } from '@mindwtr/core';
import * as dataTransfer from '@/lib/data-transfer';
import { useSyncSettingsBackupActions } from './use-sync-settings-backup-actions';

const FIXTURE = new URL('./use-sync-settings-backup-actions.parity.fixtures.json', import.meta.url).pathname;
const t = getTranslator('en');
const tr = (key: string, values?: Record<string, string | number | boolean | null | undefined>) => resolveI18nText(t, key, { values: values as never });
const SNAPSHOT = 'data.2026-08-13T10-00-00.000.snapshot.json';
const document = { uri: 'file://cache/picked', fileName: 'picked.zip' };
const warnings = ['Skipped 2 rows without a title.', 'Unsupported repeat rule kept as text.'];
const projects = (count: number, areas = false) => Array.from({ length: count }, (_, index) => ({
    name: `Project ${index + 1}`, taskCount: index + 2, ...(areas && index % 2 === 0 ? { areaName: `Area ${index}` } : {}),
}));
const counts = { importedTaskCount: 12, importedProjectCount: 3, importedSectionCount: 2, importedAreaCount: 1, importedChecklistItemCount: 4, importedStandaloneTaskCount: 5 };

type Flow = { handler: string; pick: string; inspect: string; apply: string; preview: Record<string, unknown>; result: Record<string, unknown> };
const flows = (rich: boolean): Flow[] => {
    const w = rich ? warnings : [];
    const zero = rich ? 1 : 0;
    return [
        { handler: 'handleImportTodoist', pick: 'pickTodoistDocument', inspect: 'inspectTodoistDocument', apply: 'importTodoistData',
            preview: { taskCount: 9, projectCount: rich ? 6 : 2, sectionCount: 3 * zero, checklistItemCount: 4 * zero, projects: projects(rich ? 6 : 2), warnings: w },
            result: { ...counts, importedChecklistItemCount: 4 * zero, warnings: w } },
        { handler: 'handleImportTickTick', pick: 'pickTickTickDocument', inspect: 'inspectTickTickDocument', apply: 'importTickTickData',
            preview: { taskCount: 9, fileName: 'ticktick.zip', areaCount: zero, projectCount: rich ? 6 : 0, checklistItemCount: 2 * zero, recurringCount: zero, projects: projects(rich ? 6 : 0, true), warnings: w },
            result: { ...counts, importedChecklistItemCount: 4 * zero, warnings: w } },
        { handler: 'handleImportDgt', pick: 'pickDgtDocument', inspect: 'inspectDgtDocument', apply: 'importDgtData',
            preview: { taskCount: 9, fileName: 'dgt.json', areaCount: zero, projectCount: rich ? 6 : 0, checklistItemCount: 2 * zero, standaloneTaskCount: zero, projects: projects(rich ? 6 : 0, true), warnings: w },
            result: { ...counts, importedChecklistItemCount: 4 * zero, warnings: w } },
        { handler: 'handleImportOmniFocus', pick: 'pickOmniFocusDocument', inspect: 'inspectOmniFocusDocument', apply: 'importOmniFocusData',
            preview: { taskCount: 9, fileName: 'omnifocus.csv', projectCount: rich ? 6 : 0, areaCount: zero, checklistItemCount: 2 * zero, standaloneTaskCount: zero, projects: projects(rich ? 6 : 0), warnings: w },
            result: { ...counts, importedAreaCount: zero, importedChecklistItemCount: 4 * zero, importedStandaloneTaskCount: 5 * zero, warnings: w } },
        { handler: 'handleImportMindwtrCsv', pick: 'pickMindwtrCsvDocument', inspect: 'inspectMindwtrCsvDocument', apply: 'importMindwtrCsvData',
            preview: { taskCount: 9, fileName: 'mindwtr.csv', areaCount: zero, projectCount: rich ? 6 : 0, sectionCount: 2 * zero, checklistItemCount: 2 * zero, standaloneTaskCount: zero, projects: projects(rich ? 6 : 0, true), warnings: w },
            result: { ...counts, importedChecklistItemCount: 4 * zero, warnings: w } },
    ];
};

describe('Settings › Data texts: frozen RN parity', () => {
    let latest: ReturnType<typeof useSyncSettingsBackupActions> | null = null;
    const showToast = vi.fn();
    const showSettingsWarning = vi.fn();
    function Harness() {
        latest = useSyncSettingsBackupActions({
            refreshRecoverySnapshots: vi.fn(), settings: {}, setBackupAction: vi.fn(), showSettingsErrorToast: vi.fn(),
            showSettingsWarning, showToast, t, tr, updateSettings: vi.fn().mockResolvedValue(undefined),
        });
        return null;
    }
    const pressConfirm = async () => {
        const buttons = vi.mocked(Alert.alert).mock.calls.at(-1)?.[2] as { onPress?: () => unknown }[];
        await act(async () => { await buttons[1].onPress?.(); });
    };
    const lastAlert = () => { const [title, message] = vi.mocked(Alert.alert).mock.calls.at(-1)!; return { title, message }; };
    const lastToast = () => { const { title, message } = showToast.mock.calls.at(-1)![0]; return { title, message }; };

    beforeEach(() => { vi.clearAllMocks(); latest = null; });

    it('keeps every preview and result byte for byte', async () => {
        await act(async () => { create(<Harness />); });
        const seen: Record<string, unknown> = {};

        const mocks = { ...dataTransfer } as unknown as Record<string, ReturnType<typeof vi.fn>>;
        for (const rich of [false, true]) {
            for (const flow of flows(rich)) {
                mocks[flow.pick].mockResolvedValue(document);
                mocks[flow.inspect].mockResolvedValue({
                    valid: true, preview: flow.preview, parsedProjects: [], parsedData: {}, diagnostics: [],
                } as never);
                mocks[flow.apply].mockResolvedValue({ snapshotName: SNAPSHOT, result: flow.result } as never);
                await latest![flow.handler as 'handleImportTodoist']();
                const preview = lastAlert();
                await pressConfirm();
                seen[`${flow.handler}:${rich ? 'rich' : 'plain'}`] = { preview, result: lastToast() };
            }
            for (const mode of ['restore', 'merge'] as const) {
                const metadata = rich ? { backupAt: '2026-08-13T10:00:00.000Z', taskCount: 7, projectCount: 2 } : { fileName: 'backup.json', taskCount: 1, projectCount: 0 };
                vi.mocked(dataTransfer.pickBackupDocument).mockResolvedValue({ uri: 'file://cache/backup.json', fileName: 'backup.json' });
                vi.mocked(dataTransfer.inspectBackupDocument).mockResolvedValue({
                    valid: true, data: { tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} }, errors: [], warnings: rich ? warnings : [],
                    ...(rich ? {} : { diagnostics: [] }), metadata,
                } as never);
                vi.mocked(dataTransfer.restoreDataFromBackup).mockResolvedValue({ snapshotName: SNAPSHOT } as never);
                vi.mocked(dataTransfer.mergeDataFromBackup).mockResolvedValue({ snapshotName: SNAPSHOT, result: {
                    tasks: { added: 3, updated: 1, conflicts: 0, resolvedUsingLocal: 0, resolvedUsingIncoming: 1, deletionsWon: 0, invalidTimestamps: 0, timestampAdjustments: 0, timestampAdjustmentIds: [] },
                    projects: { added: 1, updated: 0, conflicts: 0, resolvedUsingLocal: 0, resolvedUsingIncoming: 0, deletionsWon: 0, invalidTimestamps: 0, timestampAdjustments: 0, timestampAdjustmentIds: [] },
                } } as never);
                await latest![mode === 'restore' ? 'handleRestoreBackup' : 'handleMergeBackup']();
                const preview = lastAlert();
                await pressConfirm();
                seen[`${mode}:${rich ? 'rich' : 'plain'}`] = { preview, result: lastToast() };
            }
        }

        const text = `${JSON.stringify(seen, null, 2)}\n`.split(new Date('2026-08-13T10:00:00.000Z').toLocaleString()).join('<backupDate>');
        if (process.env.MINDWTR_FREEZE_PARITY === '1' || !existsSync(FIXTURE)) writeFileSync(FIXTURE, text);
        expect(text).toBe(readFileSync(FIXTURE, 'utf8'));
    });
});
