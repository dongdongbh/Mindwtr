import { useCallback } from 'react';
import { Alert } from 'react-native';
import Constants from 'expo-constants';
import {
    createImportDiagnostic,
    createImportDiagnostics,
    formatImportDiagnostic,
    getBackupSourceFileDiagnostic,
    getInMemoryAppDataSnapshot,
    summarizeBackupMerge,
    type ImportDiagnostic,
    type ImportDiagnosticSeverity,
} from '@mindwtr/core';
import type {
    BackupValidation,
    DgtImportParseResult,
    MindwtrCsvImportParseResult,
    OmniFocusImportParseResult,
    ParsedOmniFocusImportData,
    ParsedDgtImportData,
    ParsedMindwtrCsvImportData,
    ParsedTodoistProject,
    ParsedTickTickImportData,
    TickTickImportParseResult,
    TodoistImportParseResult,
} from '@mindwtr/core';

import {
    exportCurrentDataBackup,
    importDgtData,
    importMindwtrCsvData,
    importOmniFocusData,
    importTickTickData,
    importTodoistData,
    inspectBackupDocument,
    inspectDgtDocument,
    inspectMindwtrCsvDocument,
    inspectOmniFocusDocument,
    inspectTickTickDocument,
    inspectTodoistDocument,
    mergeDataFromBackup,
    pickBackupDocument,
    pickDgtDocument,
    pickMindwtrCsvDocument,
    pickOmniFocusDocument,
    pickTickTickDocument,
    pickTodoistDocument,
    restoreDataFromBackup,
    restoreLocalDataSnapshot,
} from '@/lib/data-transfer';
import { clearLog, ensureLogFilePath, logInfo } from '@/lib/app-log';
import { logSyncEncryptionDiagnosticsBlock } from '@/lib/sync-encryption-state';
import { logSettingsError } from '@/lib/settings-utils';

export type BackupAction =
    | null
    | 'export'
    | 'export:csv'
    | 'export:tasknotes'
    | 'restore'
    | 'merge'
    | 'import:todoist'
    | 'import:ticktick'
    | 'import:dgt'
    | 'import:omnifocus'
    | 'import:mindwtr-csv'
    | `snapshot:${string}`;

type UseSyncSettingsBackupActionsParams = {
    tr: (key: string, values?: Record<string, string | number | boolean | null | undefined>) => string;
    refreshRecoverySnapshots: () => Promise<void>;
    settings: Record<string, any>;
    setBackupAction: React.Dispatch<React.SetStateAction<BackupAction>>;
    showSettingsErrorToast: (title: string, message: string, durationMs?: number) => void;
    showSettingsWarning: (title: string, message: string, durationMs?: number) => void;
    showToast: (options: {
        title: string;
        message: string;
        tone: 'warning' | 'error' | 'success' | 'info';
        durationMs?: number;
        actionLabel?: string;
        onAction?: () => void | Promise<void>;
    }) => void;
    t: (key: string) => string;
    updateSettings: (updates: Record<string, any>) => Promise<unknown>;
};

export function useSyncSettingsBackupActions({
    tr,
    refreshRecoverySnapshots,
    settings,
    setBackupAction,
    showSettingsErrorToast,
    showSettingsWarning,
    showToast,
    t,
    updateSettings,
}: UseSyncSettingsBackupActionsParams) {
    const formatImportMessages = useCallback((
        messages: readonly string[],
        severity: ImportDiagnosticSeverity = 'warning',
    ): string[] => createImportDiagnostics(messages, severity)
        .map((diagnostic) => formatImportDiagnostic(diagnostic, tr)), [tr]);
    const formatImportError = useCallback((
        diagnostics: readonly ImportDiagnostic[],
        fallback: string,
    ): string => {
        const diagnostic = diagnostics.find((item) => item.severity === 'error');
        return diagnostic ? formatImportDiagnostic(diagnostic, tr) : fallback;
    }, [tr]);
    const formatThrownImportError = useCallback((error: unknown): string => formatImportDiagnostic(
        createImportDiagnostic(error instanceof Error ? error.message : '', 'error'),
        tr,
    ), [tr]);
    const formatThrownBackupError = useCallback((error: unknown): string => {
        const diagnostic = getBackupSourceFileDiagnostic(error);
        return diagnostic ? formatImportDiagnostic(diagnostic, tr) : String(error);
    }, [tr]);
    const formatRecoverySnapshotLabel = useCallback((fileName: string): string => {
        const match = fileName.match(
            /^data\.(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:\.(\d{3})(?:\.\d+)?)?\.snapshot\.json$/i,
        );
        if (!match) return fileName;
        const [, datePart, hour, minute, second, milliseconds = '000'] = match;
        const localDate = new Date(`${datePart}T${hour}:${minute}:${second}.${milliseconds}Z`);
        return `${localDate.toLocaleDateString()} ${localDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }, []);

    // Restore and merge preview the same file identically; only the sentence about what the
    // action does to local data differs.
    const buildBackupSummary = useCallback((
        validation: Awaited<ReturnType<typeof inspectBackupDocument>>,
        effect: string,
    ) => {
        const details = [
            validation.metadata?.backupAt
                ? tr('settings.backupMobile.backupDateLabel', { backupDate: new Date(validation.metadata.backupAt).toLocaleString() })
                : validation.metadata?.fileName
                    ? tr('settings.backupMobile.fileLabel', { fileName: validation.metadata.fileName })
                    : null,
            tr('settings.backupMobile.backupPreviewCounts', { taskCount: validation.metadata?.taskCount ?? 0, projectCount: validation.metadata?.projectCount ?? 0 }),
            effect,
            ...(() => {
                const warningDiagnostics = validation.diagnostics
                    ?? createImportDiagnostics(validation.warnings, 'warning');
                const warnings = warningDiagnostics
                    .filter((diagnostic) => diagnostic.severity === 'warning')
                    .map((diagnostic) => formatImportDiagnostic(diagnostic, tr));
                return warnings.length > 0 ? ['', ...warnings] : [];
            })(),
        ].filter(Boolean);
        return details.join('\n');
    }, [tr]);

    const buildTodoistSummary = useCallback((preview: NonNullable<TodoistImportParseResult['preview']>) => {
        const projectLines = preview.projects
            .slice(0, 4)
            .map((project) => `• ${project.name}: ${project.taskCount}`);
        if (preview.projects.length > 4) {
            projectLines.push(tr('settings.backupMobile.moreProjects', { projectCount: preview.projects.length - 4 }));
        }
        const details = [
            tr('settings.backupMobile.importTodoistTasksFromProjects', { taskCount: preview.taskCount, projectCount: preview.projectCount }),
            preview.sectionCount > 0
                ? tr('settings.backupMobile.sectionsWillBePreserved', { sectionCount: preview.sectionCount })
                : null,
            preview.checklistItemCount > 0
                ? tr('settings.backupMobile.subtasksWillBecomeChecklistItems', { subtaskCount: preview.checklistItemCount })
                : null,
            tr('settings.backupMobile.importedTasksStayInInboxSoYouCanProcessThem'),
            ...(projectLines.length > 0 ? ['', ...projectLines] : []),
            ...(preview.warnings.length > 0 ? ['', ...formatImportMessages(preview.warnings)] : []),
        ].filter(Boolean);
        return details.join('\n');
    }, [formatImportMessages, tr]);

    const buildTickTickSummary = useCallback((preview: NonNullable<TickTickImportParseResult['preview']>) => {
        const projectLines = preview.projects
            .slice(0, 4)
            .map((project) => `• ${project.areaName ? `${project.areaName} / ` : ''}${project.name}: ${project.taskCount}`);
        if (preview.projects.length > 4) {
            projectLines.push(tr('settings.backupMobile.moreProjects', { projectCount: preview.projects.length - 4 }));
        }
        const details = [
            tr('settings.backupMobile.importTasksFromFile', { taskCount: preview.taskCount, fileName: preview.fileName }),
            preview.areaCount > 0
                ? tr('settings.backupMobile.ticktickAreasWillBeCreated', { areaCount: preview.areaCount })
                : null,
            preview.projectCount > 0
                ? tr('settings.backupMobile.ticktickProjectsWillBeCreated', { projectCount: preview.projectCount })
                : null,
            preview.checklistItemCount > 0
                ? tr('settings.backupMobile.checklistItemsWillBePreserved', { checklistItemCount: preview.checklistItemCount })
                : null,
            preview.recurringCount > 0
                ? tr('settings.backupMobile.recurringTasksWillKeepSupportedRepeatRules', { taskCount: preview.recurringCount })
                : null,
            tr('settings.backupMobile.importedTasksStayInInboxSoYouCanProcessThem'),
            ...(projectLines.length > 0 ? ['', ...projectLines] : []),
            ...(preview.warnings.length > 0 ? ['', ...formatImportMessages(preview.warnings)] : []),
        ].filter(Boolean);
        return details.join('\n');
    }, [formatImportMessages, tr]);

    const buildDgtSummary = useCallback((preview: NonNullable<DgtImportParseResult['preview']>) => {
        const projectLines = preview.projects
            .slice(0, 4)
            .map((project) => `• ${project.areaName ? `${project.areaName} / ` : ''}${project.name}: ${project.taskCount}`);
        if (preview.projects.length > 4) {
            projectLines.push(tr('settings.backupMobile.moreProjects', { projectCount: preview.projects.length - 4 }));
        }
        const details = [
            tr('settings.backupMobile.importTasksFromFile', { taskCount: preview.taskCount, fileName: preview.fileName }),
            preview.areaCount > 0
                ? tr('settings.backupMobile.dgtAreasWillBeCreated', { areaCount: preview.areaCount })
                : null,
            preview.projectCount > 0
                ? tr('settings.backupMobile.projectsWillBeCreated', { projectCount: preview.projectCount })
                : null,
            preview.checklistItemCount > 0
                ? tr('settings.backupMobile.checklistItemsWillBePreserved', { checklistItemCount: preview.checklistItemCount })
                : null,
            preview.standaloneTaskCount > 0
                ? tr('settings.backupMobile.tasksWillStayOutsideProjects', { taskCount: preview.standaloneTaskCount })
                : null,
            ...(projectLines.length > 0 ? ['', ...projectLines] : []),
            ...(preview.warnings.length > 0 ? ['', ...formatImportMessages(preview.warnings)] : []),
        ].filter(Boolean);
        return details.join('\n');
    }, [formatImportMessages, tr]);

    const buildOmniFocusSummary = useCallback((preview: NonNullable<OmniFocusImportParseResult['preview']>) => {
        const projectLines = preview.projects
            .slice(0, 4)
            .map((project) => `• ${project.name}: ${project.taskCount}`);
        if (preview.projects.length > 4) {
            projectLines.push(tr('settings.backupMobile.moreProjects', { projectCount: preview.projects.length - 4 }));
        }
        const details = [
            tr('settings.backupMobile.importTaskCountFromFile', { taskCount: preview.taskCount, fileName: preview.fileName }),
            preview.projectCount > 0
                ? tr('settings.backupMobile.projectsWillBeCreatedWhenNeeded', { projectCount: preview.projectCount })
                : null,
            preview.areaCount > 0
                ? tr('settings.backupMobile.omnifocusAreasWillBeCreated', { areaCount: preview.areaCount })
                : null,
            preview.checklistItemCount > 0
                ? tr('settings.backupMobile.nestedTasksWillBecomeChecklistItems', { taskCount: preview.checklistItemCount })
                : null,
            preview.standaloneTaskCount > 0
                ? tr('settings.backupMobile.tasksWillStayOutsideProjects', { taskCount: preview.standaloneTaskCount })
                : null,
            tr('settings.backupMobile.importedTasksKeepOmnifocusNotesDatesTagsRecurrenceAndChecklist'),
            ...(projectLines.length > 0 ? ['', ...projectLines] : []),
            ...(preview.warnings.length > 0 ? ['', ...formatImportMessages(preview.warnings)] : []),
        ].filter(Boolean);
        return details.join('\n');
    }, [formatImportMessages, tr]);

    const buildMindwtrCsvSummary = useCallback((preview: NonNullable<MindwtrCsvImportParseResult['preview']>) => {
        const projectLines = preview.projects
            .slice(0, 4)
            .map((project) => `• ${project.areaName ? `${project.areaName} / ` : ''}${project.name}: ${project.taskCount}`);
        if (preview.projects.length > 4) {
            projectLines.push(tr('settings.backupMobile.moreProjects', { projectCount: preview.projects.length - 4 }));
        }
        const details = [
            tr('settings.backupMobile.importTasksFromFile', { taskCount: preview.taskCount, fileName: preview.fileName }),
            preview.areaCount > 0
                ? tr('settings.backupMobile.mindwtrCsvAreasWillBeCreated', { areaCount: preview.areaCount })
                : null,
            preview.projectCount > 0
                ? tr('settings.backupMobile.projectsWillBeCreatedWhenNeeded', { projectCount: preview.projectCount })
                : null,
            preview.sectionCount > 0
                ? tr('settings.backupMobile.mindwtrCsvSectionsWillBeCreated', { sectionCount: preview.sectionCount })
                : null,
            preview.checklistItemCount > 0
                ? tr('settings.backupMobile.checklistItemsWillBePreserved', { checklistItemCount: preview.checklistItemCount })
                : null,
            preview.standaloneTaskCount > 0
                ? tr('settings.backupMobile.tasksWillStayOutsideProjects', { taskCount: preview.standaloneTaskCount })
                : null,
            ...(projectLines.length > 0 ? ['', ...projectLines] : []),
            ...(preview.warnings.length > 0 ? ['', ...formatImportMessages(preview.warnings)] : []),
        ].filter(Boolean);
        return details.join('\n');
    }, [formatImportMessages, tr]);

    const handleBackup = useCallback(async () => {
        setBackupAction('export');
        try {
            await exportCurrentDataBackup(getInMemoryAppDataSnapshot());
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(tr('settings.syncMobile.error'), tr('settings.backupMobile.failedToExportBackup'));
        } finally {
            setBackupAction(null);
        }
    }, [tr, setBackupAction, showSettingsErrorToast]);

    const handleExportCsv = useCallback(async () => {
        setBackupAction('export:csv');
        try {
            await exportCurrentDataBackup(getInMemoryAppDataSnapshot(), 'csv');
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(tr('settings.syncMobile.error'), tr('settings.exportCsvFailed'));
        } finally {
            setBackupAction(null);
        }
    }, [tr, setBackupAction, showSettingsErrorToast]);

    // `undo` only swaps the copy: an undo IS a snapshot restore, so it keeps the
    // same destructive-confirmation weight and the same restore path.
    const handleExportTaskNotes = useCallback(async () => {
        setBackupAction('export:tasknotes');
        try {
            await exportCurrentDataBackup(getInMemoryAppDataSnapshot(), 'tasknotes');
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(tr('settings.syncMobile.error'), tr('settings.exportTaskNotesFailed'));
        } finally {
            setBackupAction(null);
        }
    }, [tr, setBackupAction, showSettingsErrorToast]);

    const handleRestoreRecoverySnapshot = useCallback(async (snapshotName: string, undo = false) => {
        Alert.alert(
            undo
                ? tr('settings.undoImportConfirmTitle')
                : tr('settings.backupMobile.restoreRecoverySnapshot'),
            undo
                ? tr('settings.undoImportConfirm', { snapshotName: formatRecoverySnapshotLabel(snapshotName) })
                : tr('settings.backupMobile.restoreSnapshotReplaceLocalData', { snapshotName: formatRecoverySnapshotLabel(snapshotName) }),
            [
                { text: tr('common.cancel'), style: 'cancel' },
                {
                    text: tr('markdown.referenceRestore'),
                    style: 'destructive',
                    onPress: async () => {
                        setBackupAction(`snapshot:${snapshotName}`);
                        try {
                            await restoreLocalDataSnapshot(snapshotName);
                            await refreshRecoverySnapshots();
                            showToast({
                                title: tr('settings.backupMobile.restoreComplete'),
                                message: tr('settings.backupMobile.recoverySnapshotRestored'),
                                tone: 'success',
                            });
                        } catch (error) {
                            logSettingsError(error);
                            showSettingsErrorToast(tr('settings.backupMobile.restoreFailed'), String(error), 5200);
                        } finally {
                            setBackupAction(null);
                        }
                    },
                },
            ]
        );
    }, [formatRecoverySnapshotLabel, tr, refreshRecoverySnapshots, setBackupAction, showSettingsErrorToast, showToast]);

    const confirmRestoreBackup = useCallback(async (validation: BackupValidation) => {
        if (!validation.data) return;
        setBackupAction('restore');
        try {
            const { snapshotName } = await restoreDataFromBackup(validation.data);
            await refreshRecoverySnapshots();
            showToast({
                title: tr('settings.backupMobile.restoreComplete'),
                message: tr('settings.backupMobile.backupRestoredWithSnapshot', { snapshotName }),
                tone: 'success',
                durationMs: 5000,
                actionLabel: tr('settings.undoImport'),
                onAction: () => handleRestoreRecoverySnapshot(snapshotName, true),
            });
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(tr('settings.backupMobile.restoreFailed'), String(error), 5200);
        } finally {
            setBackupAction(null);
        }
    }, [handleRestoreRecoverySnapshot, tr, refreshRecoverySnapshots, setBackupAction, showSettingsErrorToast, showToast]);

    const handleRestoreBackup = useCallback(async () => {
        setBackupAction('restore');
        try {
            const document = await pickBackupDocument();
            if (!document) return;
            const validation = await inspectBackupDocument(document, {
                appVersion: Constants.expoConfig?.version ?? '0.0.0',
            });
            if (!validation.valid || !validation.data) {
                showSettingsWarning(
                    tr('settings.backupMobile.invalidBackup'),
                    formatImportError(
                        validation.diagnostics ?? createImportDiagnostics(validation.errors, 'error'),
                        tr('settings.backupMobile.thisFileIsNotAValidMindwtrBackup'),
                    )
                );
                return;
            }
            const summary = buildBackupSummary(
                validation,
                tr('settings.backupMobile.thisWillReplaceAllCurrentLocalDataARecoverySnapshot'),
            );
            Alert.alert(
                tr('settings.backupMobile.restoreBackup'),
                summary,
                [
                    { text: tr('common.cancel'), style: 'cancel' },
                    {
                        text: tr('markdown.referenceRestore'),
                        style: 'destructive',
                        onPress: () => void confirmRestoreBackup(validation),
                    },
                ]
            );
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(tr('settings.backupMobile.restoreFailed'), formatThrownBackupError(error), 5200);
        } finally {
            setBackupAction(null);
        }
    }, [buildBackupSummary, confirmRestoreBackup, formatImportError, formatThrownBackupError, tr, setBackupAction, showSettingsErrorToast, showSettingsWarning]);

    const confirmMergeBackup = useCallback(async (validation: BackupValidation) => {
        if (!validation.data) return;
        setBackupAction('merge');
        try {
            const { snapshotName, result } = await mergeDataFromBackup(validation.data);
            await refreshRecoverySnapshots();
            const merged = summarizeBackupMerge(result);
            const details = [
                tr('settings.mergeBackupSummary', { addedCount: merged.added, updatedCount: merged.updated }),
                tr('settings.backupMobile.recoverySnapshotSaved', { snapshotName }),
            ];
            showToast({
                title: tr('settings.mergeBackup'),
                message: details.join('\n'),
                tone: 'success',
                durationMs: 5600,
                actionLabel: tr('settings.undoImport'),
                onAction: () => handleRestoreRecoverySnapshot(snapshotName, true),
            });
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(tr('settings.mergeBackupFailed'), String(error), 5200);
        } finally {
            setBackupAction(null);
        }
    }, [handleRestoreRecoverySnapshot, tr, refreshRecoverySnapshots, setBackupAction, showSettingsErrorToast, showToast]);

    const handleMergeBackup = useCallback(async () => {
        setBackupAction('merge');
        try {
            const document = await pickBackupDocument();
            if (!document) return;
            const validation = await inspectBackupDocument(document, {
                appVersion: Constants.expoConfig?.version ?? '0.0.0',
            });
            if (!validation.valid || !validation.data) {
                showSettingsWarning(
                    tr('settings.backupMobile.invalidBackup'),
                    formatImportError(
                        validation.diagnostics ?? createImportDiagnostics(validation.errors, 'error'),
                        tr('settings.backupMobile.thisFileIsNotAValidMindwtrBackup'),
                    )
                );
                return;
            }
            Alert.alert(
                tr('settings.mergeBackup'),
                buildBackupSummary(validation, tr('settings.mergeBackupConfirm')),
                [
                    { text: tr('common.cancel'), style: 'cancel' },
                    {
                        text: tr('settings.mergeBackupAction'),
                        onPress: () => void confirmMergeBackup(validation),
                    },
                ]
            );
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(tr('settings.mergeBackupFailed'), formatThrownBackupError(error), 5200);
        } finally {
            setBackupAction(null);
        }
    }, [buildBackupSummary, confirmMergeBackup, formatImportError, formatThrownBackupError, tr, setBackupAction, showSettingsErrorToast, showSettingsWarning]);

    const confirmTodoistImport = useCallback(async (parsedProjects: ParsedTodoistProject[]) => {
        setBackupAction('import:todoist');
        try {
            const { snapshotName, result } = await importTodoistData(parsedProjects);
            await refreshRecoverySnapshots();
            const details = [
                tr('settings.backupMobile.importedTodoistTasksIntoProjects', { taskCount: result.importedTaskCount, projectCount: result.importedProjectCount }),
                result.importedChecklistItemCount > 0
                    ? tr('settings.backupMobile.subtasksBecameChecklistItems', { subtaskCount: result.importedChecklistItemCount })
                    : null,
                tr('settings.backupMobile.recoverySnapshotSaved', { snapshotName }),
                ...(result.warnings.length > 0 ? ['', ...formatImportMessages(result.warnings)] : []),
            ].filter(Boolean);
            showToast({
                title: tr('settings.backupMobile.importComplete'),
                message: details.join('\n'),
                tone: 'success',
                durationMs: 5600,
                actionLabel: tr('settings.undoImport'),
                onAction: () => handleRestoreRecoverySnapshot(snapshotName, true),
            });
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(tr('settings.backupMobile.importFailed'), formatThrownImportError(error), 5200);
        } finally {
            setBackupAction(null);
        }
    }, [handleRestoreRecoverySnapshot, formatImportMessages, formatThrownImportError, tr, refreshRecoverySnapshots, setBackupAction, showSettingsErrorToast, showToast]);

    const confirmTickTickImport = useCallback(async (parsedData: ParsedTickTickImportData) => {
        setBackupAction('import:ticktick');
        try {
            const { snapshotName, result } = await importTickTickData(parsedData);
            await refreshRecoverySnapshots();
            const details = [
                tr('settings.backupMobile.importedTaskProjectAreaCounts', { taskCount: result.importedTaskCount, projectCount: result.importedProjectCount, areaCount: result.importedAreaCount }),
                result.importedChecklistItemCount > 0
                    ? tr('settings.backupMobile.checklistItemsPreserved', { checklistItemCount: result.importedChecklistItemCount })
                    : null,
                tr('settings.backupMobile.recoverySnapshotSaved', { snapshotName }),
                ...(result.warnings.length > 0 ? ['', ...formatImportMessages(result.warnings)] : []),
            ].filter(Boolean);
            showToast({
                title: tr('settings.backupMobile.importComplete'),
                message: details.join('\n'),
                tone: 'success',
                durationMs: 6200,
                actionLabel: tr('settings.undoImport'),
                onAction: () => handleRestoreRecoverySnapshot(snapshotName, true),
            });
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(tr('settings.backupMobile.importFailed'), formatThrownImportError(error), 5200);
        } finally {
            setBackupAction(null);
        }
    }, [handleRestoreRecoverySnapshot, formatImportMessages, formatThrownImportError, tr, refreshRecoverySnapshots, setBackupAction, showSettingsErrorToast, showToast]);

    const confirmDgtImport = useCallback(async (parsedData: ParsedDgtImportData) => {
        setBackupAction('import:dgt');
        try {
            const { snapshotName, result } = await importDgtData(parsedData);
            await refreshRecoverySnapshots();
            const details = [
                tr('settings.backupMobile.importedTaskProjectAreaCounts', { taskCount: result.importedTaskCount, projectCount: result.importedProjectCount, areaCount: result.importedAreaCount }),
                result.importedChecklistItemCount > 0
                    ? tr('settings.backupMobile.checklistItemsPreserved', { checklistItemCount: result.importedChecklistItemCount })
                    : null,
                tr('settings.backupMobile.recoverySnapshotSaved', { snapshotName }),
                ...(result.warnings.length > 0 ? ['', ...formatImportMessages(result.warnings)] : []),
            ].filter(Boolean);
            showToast({
                title: tr('settings.backupMobile.importComplete'),
                message: details.join('\n'),
                tone: 'success',
                durationMs: 6200,
                actionLabel: tr('settings.undoImport'),
                onAction: () => handleRestoreRecoverySnapshot(snapshotName, true),
            });
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(tr('settings.backupMobile.importFailed'), formatThrownImportError(error), 5200);
        } finally {
            setBackupAction(null);
        }
    }, [handleRestoreRecoverySnapshot, formatImportMessages, formatThrownImportError, tr, refreshRecoverySnapshots, setBackupAction, showSettingsErrorToast, showToast]);

    const confirmOmniFocusImport = useCallback(async (parsedData: ParsedOmniFocusImportData) => {
        setBackupAction('import:omnifocus');
        try {
            const { snapshotName, result } = await importOmniFocusData(parsedData);
            await refreshRecoverySnapshots();
            const details = [
                tr('settings.backupMobile.importedTaskProjectCounts', { taskCount: result.importedTaskCount, projectCount: result.importedProjectCount }),
                result.importedAreaCount > 0
                    ? tr('settings.backupMobile.omnifocusAreasCreated', { areaCount: result.importedAreaCount })
                    : null,
                result.importedChecklistItemCount > 0
                    ? tr('settings.backupMobile.nestedTasksBecameChecklistItems', { taskCount: result.importedChecklistItemCount })
                    : null,
                result.importedStandaloneTaskCount > 0
                    ? tr('settings.backupMobile.tasksStayedOutsideProjects', { taskCount: result.importedStandaloneTaskCount })
                    : null,
                tr('settings.backupMobile.recoverySnapshotSaved', { snapshotName }),
                ...(result.warnings.length > 0 ? ['', ...formatImportMessages(result.warnings)] : []),
            ].filter(Boolean);
            showToast({
                title: tr('settings.backupMobile.importComplete'),
                message: details.join('\n'),
                tone: 'success',
                durationMs: 6200,
                actionLabel: tr('settings.undoImport'),
                onAction: () => handleRestoreRecoverySnapshot(snapshotName, true),
            });
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(tr('settings.backupMobile.importFailed'), formatThrownImportError(error), 5200);
        } finally {
            setBackupAction(null);
        }
    }, [handleRestoreRecoverySnapshot, formatImportMessages, formatThrownImportError, tr, refreshRecoverySnapshots, setBackupAction, showSettingsErrorToast, showToast]);

    const confirmMindwtrCsvImport = useCallback(async (parsedData: ParsedMindwtrCsvImportData) => {
        setBackupAction('import:mindwtr-csv');
        try {
            const { snapshotName, result } = await importMindwtrCsvData(parsedData);
            await refreshRecoverySnapshots();
            const details = [
                tr('settings.backupMobile.importedTaskProjectSectionAreaCounts', {
                    taskCount: result.importedTaskCount,
                    projectCount: result.importedProjectCount,
                    sectionCount: result.importedSectionCount,
                    areaCount: result.importedAreaCount,
                }),
                result.importedChecklistItemCount > 0
                    ? tr('settings.backupMobile.checklistItemsPreserved', { checklistItemCount: result.importedChecklistItemCount })
                    : null,
                tr('settings.backupMobile.recoverySnapshotSaved', { snapshotName }),
                ...(result.warnings.length > 0 ? ['', ...formatImportMessages(result.warnings)] : []),
            ].filter(Boolean);
            showToast({
                title: tr('settings.backupMobile.importComplete'),
                message: details.join('\n'),
                tone: 'success',
                durationMs: 6200,
                actionLabel: tr('settings.undoImport'),
                onAction: () => handleRestoreRecoverySnapshot(snapshotName, true),
            });
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(tr('settings.backupMobile.importFailed'), formatThrownImportError(error), 5200);
        } finally {
            setBackupAction(null);
        }
    }, [handleRestoreRecoverySnapshot, formatImportMessages, formatThrownImportError, tr, refreshRecoverySnapshots, setBackupAction, showSettingsErrorToast, showToast]);

    const handleImportTodoist = useCallback(async () => {
        setBackupAction('import:todoist');
        try {
            const document = await pickTodoistDocument();
            if (!document) return;
            const parseResult = await inspectTodoistDocument(document);
            if (!parseResult.valid || !parseResult.preview) {
                showSettingsWarning(
                    tr('settings.backupMobile.importFailed'),
                    formatImportError(parseResult.diagnostics, tr('settings.backupMobile.theSelectedFileIsNotASupportedTodoistExport'))
                );
                return;
            }
            Alert.alert(
                tr('settings.backupMobile.importTodoistData'),
                buildTodoistSummary(parseResult.preview),
                [
                    { text: tr('common.cancel'), style: 'cancel' },
                    {
                        text: tr('settings.backupMobile.import'),
                        onPress: () => void confirmTodoistImport(parseResult.parsedProjects),
                    },
                ]
            );
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(tr('settings.backupMobile.importFailed'), formatThrownImportError(error), 5200);
        } finally {
            setBackupAction(null);
        }
    }, [buildTodoistSummary, confirmTodoistImport, formatImportError, formatThrownImportError, tr, setBackupAction, showSettingsErrorToast, showSettingsWarning]);

    const handleImportTickTick = useCallback(async () => {
        setBackupAction('import:ticktick');
        try {
            const document = await pickTickTickDocument();
            if (!document) return;
            const parseResult = await inspectTickTickDocument(document);
            if (!parseResult.valid || !parseResult.preview || !parseResult.parsedData) {
                showSettingsWarning(
                    tr('settings.backupMobile.importFailed'),
                    formatImportError(parseResult.diagnostics, tr('settings.backupMobile.theSelectedFileIsNotASupportedTicktickBackup'))
                );
                return;
            }
            const parsedData = parseResult.parsedData;
            Alert.alert(
                tr('settings.backupMobile.importTicktickData'),
                buildTickTickSummary(parseResult.preview),
                [
                    { text: tr('common.cancel'), style: 'cancel' },
                    {
                        text: tr('settings.backupMobile.import'),
                        onPress: () => void confirmTickTickImport(parsedData),
                    },
                ]
            );
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(tr('settings.backupMobile.importFailed'), formatThrownImportError(error), 5200);
        } finally {
            setBackupAction(null);
        }
    }, [buildTickTickSummary, confirmTickTickImport, formatImportError, formatThrownImportError, tr, setBackupAction, showSettingsErrorToast, showSettingsWarning]);

    const handleImportDgt = useCallback(async () => {
        setBackupAction('import:dgt');
        try {
            const document = await pickDgtDocument();
            if (!document) return;
            const parseResult = await inspectDgtDocument(document);
            if (!parseResult.valid || !parseResult.preview || !parseResult.parsedData) {
                showSettingsWarning(
                    tr('settings.backupMobile.importFailed'),
                    formatImportError(parseResult.diagnostics, tr('settings.backupMobile.theSelectedFileIsNotASupportedDgtGtdExport'))
                );
                return;
            }
            const parsedData = parseResult.parsedData;
            Alert.alert(
                tr('settings.backupMobile.importDgtGtdData'),
                buildDgtSummary(parseResult.preview),
                [
                    { text: tr('common.cancel'), style: 'cancel' },
                    {
                        text: tr('settings.backupMobile.import'),
                        onPress: () => void confirmDgtImport(parsedData),
                    },
                ]
            );
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(tr('settings.backupMobile.importFailed'), formatThrownImportError(error), 5200);
        } finally {
            setBackupAction(null);
        }
    }, [buildDgtSummary, confirmDgtImport, formatImportError, formatThrownImportError, tr, setBackupAction, showSettingsErrorToast, showSettingsWarning]);

    const handleImportOmniFocus = useCallback(async () => {
        setBackupAction('import:omnifocus');
        try {
            const document = await pickOmniFocusDocument();
            if (!document) return;
            const parseResult = await inspectOmniFocusDocument(document);
            if (!parseResult.valid || !parseResult.preview || !parseResult.parsedData) {
                showSettingsWarning(
                    tr('settings.backupMobile.importFailed'),
                    formatImportError(parseResult.diagnostics, tr('settings.backupMobile.theSelectedFileIsNotASupportedOmnifocusExport'))
                );
                return;
            }
            const parsedData = parseResult.parsedData;
            Alert.alert(
                tr('settings.backupMobile.importOmnifocusData'),
                buildOmniFocusSummary(parseResult.preview),
                [
                    { text: tr('common.cancel'), style: 'cancel' },
                    {
                        text: tr('settings.backupMobile.import'),
                        onPress: () => void confirmOmniFocusImport(parsedData),
                    },
                ]
            );
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(tr('settings.backupMobile.importFailed'), formatThrownImportError(error), 5200);
        } finally {
            setBackupAction(null);
        }
    }, [buildOmniFocusSummary, confirmOmniFocusImport, formatImportError, formatThrownImportError, tr, setBackupAction, showSettingsErrorToast, showSettingsWarning]);

    const handleImportMindwtrCsv = useCallback(async () => {
        setBackupAction('import:mindwtr-csv');
        try {
            const document = await pickMindwtrCsvDocument();
            if (!document) return;
            const parseResult = await inspectMindwtrCsvDocument(document);
            if (!parseResult.valid || !parseResult.preview || !parseResult.parsedData) {
                showSettingsWarning(
                    tr('settings.backupMobile.importFailed'),
                    formatImportError(parseResult.diagnostics, tr('settings.backupMobile.theSelectedFileIsNotASupportedMindwtrCsvFile'))
                );
                return;
            }
            const parsedData = parseResult.parsedData;
            Alert.alert(
                tr('settings.backupMobile.importMindwtrCsvData'),
                buildMindwtrCsvSummary(parseResult.preview),
                [
                    { text: tr('common.cancel'), style: 'cancel' },
                    {
                        text: tr('settings.backupMobile.import'),
                        onPress: () => void confirmMindwtrCsvImport(parsedData),
                    },
                ]
            );
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(tr('settings.backupMobile.importFailed'), formatThrownImportError(error), 5200);
        } finally {
            setBackupAction(null);
        }
    }, [buildMindwtrCsvSummary, confirmMindwtrCsvImport, formatImportError, formatThrownImportError, tr, setBackupAction, showSettingsErrorToast, showSettingsWarning]);

    const toggleDebugLogging = useCallback((value: boolean) => {
        updateSettings({
            diagnostics: {
                ...(settings.diagnostics ?? {}),
                loggingEnabled: value,
            },
        })
            .then(async () => {
                if (!value) return;
                const ensuredPath = await ensureLogFilePath();
                if (!ensuredPath) return;
                await logInfo('Debug logging enabled', { scope: 'diagnostics', force: true });
            })
            .catch(logSettingsError);
    }, [settings.diagnostics, updateSettings]);

    const handleShareLog = useCallback(async () => {
        // Stamp the current encryption posture into the log before it leaves the device: a
        // shared log has to answer "what state was this device in" even when the user never
        // opened the Encryption block and only turned Debug logging on after the failure.
        await logSyncEncryptionDiagnosticsBlock().catch(() => undefined);
        const path = await ensureLogFilePath();
        if (!path) {
            showToast({
                title: t('settings.debugLogging'),
                message: t('settings.logMissing'),
                tone: 'warning',
            });
            return;
        }
        try {
            const Sharing = await import('expo-sharing');
            const canShare = await Sharing.isAvailableAsync();
            if (!canShare) {
                showToast({
                    title: t('settings.debugLogging'),
                    message: t('settings.shareUnavailable'),
                    tone: 'warning',
                });
                return;
            }
            await Sharing.shareAsync(path, { mimeType: 'text/plain' });
        } catch (error) {
            logSettingsError(error);
            showToast({
                title: t('settings.debugLogging'),
                message: t('settings.shareUnavailable'),
                tone: 'warning',
            });
        }
    }, [showToast, t]);

    const handleClearLog = useCallback(async () => {
        await clearLog();
        showToast({
            title: t('settings.debugLogging'),
            message: t('settings.logCleared'),
            tone: 'success',
        });
    }, [showToast, t]);

    return {
        formatRecoverySnapshotLabel,
        handleBackup,
        handleExportCsv,
        handleExportTaskNotes,
        handleClearLog,
        handleImportDgt,
        handleImportMindwtrCsv,
        handleImportOmniFocus,
        handleImportTickTick,
        handleImportTodoist,
        handleMergeBackup,
        handleRestoreBackup,
        handleRestoreRecoverySnapshot,
        handleShareLog,
        toggleDebugLogging,
    };
}
