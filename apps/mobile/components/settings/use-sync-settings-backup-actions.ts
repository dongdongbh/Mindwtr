import { useCallback } from 'react';
import { Alert } from 'react-native';
import Constants from 'expo-constants';
import type {
    Area,
    BackupValidation,
    DgtImportParseResult,
    ParsedDgtImportData,
    Project,
    ParsedTodoistProject,
    Section,
    Task,
    TodoistImportParseResult,
} from '@mindwtr/core';

import {
    exportCurrentDataBackup,
    importDgtData,
    importTodoistData,
    inspectBackupDocument,
    inspectDgtDocument,
    inspectTodoistDocument,
    pickBackupDocument,
    pickDgtDocument,
    pickTodoistDocument,
    restoreDataFromBackup,
    restoreLocalDataSnapshot,
} from '@/lib/data-transfer';
import { clearLog, ensureLogFilePath, logInfo } from '@/lib/app-log';
import { logSettingsError } from '@/lib/settings-utils';

type BackupAction = null | 'export' | 'restore' | 'import' | 'snapshot';

type UseSyncSettingsBackupActionsParams = {
    areas: Area[];
    localize: (english: string, chinese: string) => string;
    projects: Project[];
    refreshRecoverySnapshots: () => Promise<void>;
    sections: Section[];
    settings: Record<string, any>;
    setBackupAction: React.Dispatch<React.SetStateAction<BackupAction>>;
    showSettingsErrorToast: (title: string, message: string, durationMs?: number) => void;
    showSettingsWarning: (title: string, message: string, durationMs?: number) => void;
    showToast: (options: {
        title: string;
        message: string;
        tone: 'warning' | 'error' | 'success' | 'info';
        durationMs?: number;
    }) => void;
    t: (key: string) => string;
    tasks: Task[];
    updateSettings: (updates: Record<string, any>) => Promise<unknown>;
};

export function useSyncSettingsBackupActions({
    areas,
    localize,
    projects,
    refreshRecoverySnapshots,
    sections,
    settings,
    setBackupAction,
    showSettingsErrorToast,
    showSettingsWarning,
    showToast,
    t,
    tasks,
    updateSettings,
}: UseSyncSettingsBackupActionsParams) {
    const formatRecoverySnapshotLabel = useCallback((fileName: string): string => {
        const match = fileName.match(/^data\.(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.snapshot\.json$/i);
        if (!match) return fileName;
        const [, datePart, hour, minute, second] = match;
        const localDate = new Date(`${datePart}T${hour}:${minute}:${second}Z`);
        return `${localDate.toLocaleDateString()} ${localDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }, []);

    const buildBackupSummary = useCallback((validation: Awaited<ReturnType<typeof inspectBackupDocument>>) => {
        const details = [
            validation.metadata?.backupAt
                ? localize(`Backup date: ${new Date(validation.metadata.backupAt).toLocaleString()}`, `备份时间：${new Date(validation.metadata.backupAt).toLocaleString()}`)
                : validation.metadata?.fileName
                    ? localize(`File: ${validation.metadata.fileName}`, `文件：${validation.metadata.fileName}`)
                    : null,
            localize(
                `Contains ${validation.metadata?.taskCount ?? 0} tasks and ${validation.metadata?.projectCount ?? 0} projects.`,
                `包含 ${(validation.metadata?.taskCount ?? 0)} 个任务和 ${(validation.metadata?.projectCount ?? 0)} 个项目。`
            ),
            localize(
                'This will replace all current local data. A recovery snapshot will be saved first.',
                '这将替换当前所有本地数据。系统会先保存一个恢复快照。'
            ),
            ...(validation.warnings.length > 0 ? ['', ...validation.warnings] : []),
        ].filter(Boolean);
        return details.join('\n');
    }, [localize]);

    const buildTodoistSummary = useCallback((preview: NonNullable<TodoistImportParseResult['preview']>) => {
        const projectLines = preview.projects
            .slice(0, 4)
            .map((project) => `• ${project.name}: ${project.taskCount}`);
        if (preview.projects.length > 4) {
            projectLines.push(localize(`• ${preview.projects.length - 4} more project(s)…`, `• 另外还有 ${preview.projects.length - 4} 个项目…`));
        }
        const details = [
            localize(
                `Import ${preview.taskCount} tasks from ${preview.projectCount} Todoist project(s)?`,
                `导入来自 ${preview.projectCount} 个 Todoist 项目的 ${preview.taskCount} 个任务？`
            ),
            preview.sectionCount > 0
                ? localize(`${preview.sectionCount} section(s) will be preserved.`, `${preview.sectionCount} 个分组将被保留。`)
                : null,
            preview.checklistItemCount > 0
                ? localize(`${preview.checklistItemCount} subtask(s) will become checklist items.`, `${preview.checklistItemCount} 个子任务会变成清单项。`)
                : null,
            localize(
                'Imported tasks stay in Inbox so you can process them in Mindwtr.',
                '导入后的任务会保留在收集箱中，方便你在 Mindwtr 里继续处理。'
            ),
            ...(projectLines.length > 0 ? ['', ...projectLines] : []),
            ...(preview.warnings.length > 0 ? ['', ...preview.warnings] : []),
        ].filter(Boolean);
        return details.join('\n');
    }, [localize]);

    const buildDgtSummary = useCallback((preview: NonNullable<DgtImportParseResult['preview']>) => {
        const projectLines = preview.projects
            .slice(0, 4)
            .map((project) => `• ${project.areaName ? `${project.areaName} / ` : ''}${project.name}: ${project.taskCount}`);
        if (preview.projects.length > 4) {
            projectLines.push(localize(`• ${preview.projects.length - 4} more project(s)…`, `• 另外还有 ${preview.projects.length - 4} 个项目…`));
        }
        const details = [
            localize(
                `Import ${preview.taskCount} tasks from ${preview.fileName}?`,
                `导入来自 ${preview.fileName} 的 ${preview.taskCount} 个任务？`
            ),
            preview.areaCount > 0
                ? localize(`${preview.areaCount} area(s) will be created from DGT folders.`, `${preview.areaCount} 个领域将从 DGT 文件夹创建。`)
                : null,
            preview.projectCount > 0
                ? localize(`${preview.projectCount} project(s) will be created.`, `${preview.projectCount} 个项目将被创建。`)
                : null,
            preview.checklistItemCount > 0
                ? localize(`${preview.checklistItemCount} checklist item(s) will be preserved.`, `${preview.checklistItemCount} 个清单项将被保留。`)
                : null,
            preview.standaloneTaskCount > 0
                ? localize(
                    `${preview.standaloneTaskCount} task(s) will stay outside projects so you can process them in Mindwtr.`,
                    `${preview.standaloneTaskCount} 个任务会保留在项目之外，方便你在 Mindwtr 中继续整理。`
                )
                : null,
            ...(projectLines.length > 0 ? ['', ...projectLines] : []),
            ...(preview.warnings.length > 0 ? ['', ...preview.warnings] : []),
        ].filter(Boolean);
        return details.join('\n');
    }, [localize]);

    const handleBackup = useCallback(async () => {
        setBackupAction('export');
        try {
            await exportCurrentDataBackup({ tasks, projects, sections, areas, settings });
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(localize('Error', '错误'), localize('Failed to export backup', '导出备份失败'));
        } finally {
            setBackupAction(null);
        }
    }, [areas, localize, projects, sections, setBackupAction, settings, showSettingsErrorToast, tasks]);

    const confirmRestoreBackup = useCallback(async (validation: BackupValidation) => {
        if (!validation.data) return;
        setBackupAction('restore');
        try {
            const { snapshotName } = await restoreDataFromBackup(validation.data);
            await refreshRecoverySnapshots();
            showToast({
                title: localize('Restore complete', '恢复完成'),
                message: localize(
                    `Backup restored successfully. Recovery snapshot saved as ${snapshotName}.`,
                    `备份恢复成功。恢复快照已保存为 ${snapshotName}。`
                ),
                tone: 'success',
                durationMs: 5000,
            });
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(localize('Restore failed', '恢复失败'), String(error), 5200);
        } finally {
            setBackupAction(null);
        }
    }, [localize, refreshRecoverySnapshots, setBackupAction, showSettingsErrorToast, showToast]);

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
                    localize('Invalid backup', '无效备份'),
                    validation.errors[0] || localize('This file is not a valid Mindwtr backup.', '这不是有效的 Mindwtr 备份文件。')
                );
                return;
            }
            const summary = buildBackupSummary(validation);
            Alert.alert(
                localize('Restore backup?', '恢复备份？'),
                summary,
                [
                    { text: localize('Cancel', '取消'), style: 'cancel' },
                    {
                        text: localize('Restore', '恢复'),
                        style: 'destructive',
                        onPress: () => void confirmRestoreBackup(validation),
                    },
                ]
            );
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(localize('Restore failed', '恢复失败'), String(error), 5200);
        } finally {
            setBackupAction(null);
        }
    }, [buildBackupSummary, confirmRestoreBackup, localize, setBackupAction, showSettingsErrorToast, showSettingsWarning]);

    const confirmTodoistImport = useCallback(async (parsedProjects: ParsedTodoistProject[]) => {
        setBackupAction('import');
        try {
            const { snapshotName, result } = await importTodoistData(parsedProjects);
            await refreshRecoverySnapshots();
            const details = [
                localize(
                    `Imported ${result.importedTaskCount} tasks into ${result.importedProjectCount} project(s).`,
                    `已导入 ${result.importedProjectCount} 个项目中的 ${result.importedTaskCount} 个任务。`
                ),
                result.importedChecklistItemCount > 0
                    ? localize(
                        `${result.importedChecklistItemCount} subtask(s) became checklist items.`,
                        `${result.importedChecklistItemCount} 个子任务已转换为清单项。`
                    )
                    : null,
                localize(`Recovery snapshot saved as ${snapshotName}.`, `恢复快照已保存为 ${snapshotName}。`),
                ...(result.warnings.length > 0 ? ['', ...result.warnings] : []),
            ].filter(Boolean);
            showToast({
                title: localize('Import complete', '导入完成'),
                message: details.join('\n'),
                tone: 'success',
                durationMs: 5600,
            });
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(localize('Import failed', '导入失败'), String(error), 5200);
        } finally {
            setBackupAction(null);
        }
    }, [localize, refreshRecoverySnapshots, setBackupAction, showSettingsErrorToast, showToast]);

    const confirmDgtImport = useCallback(async (parsedData: ParsedDgtImportData) => {
        setBackupAction('import');
        try {
            const { snapshotName, result } = await importDgtData(parsedData);
            await refreshRecoverySnapshots();
            const details = [
                localize(
                    `Imported ${result.importedTaskCount} task(s), ${result.importedProjectCount} project(s), and ${result.importedAreaCount} area(s).`,
                    `已导入 ${result.importedTaskCount} 个任务、${result.importedProjectCount} 个项目和 ${result.importedAreaCount} 个领域。`
                ),
                result.importedChecklistItemCount > 0
                    ? localize(
                        `${result.importedChecklistItemCount} checklist item(s) were preserved.`,
                        `${result.importedChecklistItemCount} 个清单项已被保留。`
                    )
                    : null,
                localize(`Recovery snapshot saved as ${snapshotName}.`, `恢复快照已保存为 ${snapshotName}。`),
                ...(result.warnings.length > 0 ? ['', ...result.warnings] : []),
            ].filter(Boolean);
            showToast({
                title: localize('Import complete', '导入完成'),
                message: details.join('\n'),
                tone: 'success',
                durationMs: 6200,
            });
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(localize('Import failed', '导入失败'), String(error), 5200);
        } finally {
            setBackupAction(null);
        }
    }, [localize, refreshRecoverySnapshots, setBackupAction, showSettingsErrorToast, showToast]);

    const handleImportTodoist = useCallback(async () => {
        setBackupAction('import');
        try {
            const document = await pickTodoistDocument();
            if (!document) return;
            const parseResult = await inspectTodoistDocument(document);
            if (!parseResult.valid || !parseResult.preview) {
                showSettingsWarning(
                    localize('Import failed', '导入失败'),
                    parseResult.errors[0] || localize('The selected file is not a supported Todoist export.', '所选文件不是受支持的 Todoist 导出文件。')
                );
                return;
            }
            Alert.alert(
                localize('Import Todoist data?', '导入 Todoist 数据？'),
                buildTodoistSummary(parseResult.preview),
                [
                    { text: localize('Cancel', '取消'), style: 'cancel' },
                    {
                        text: localize('Import', '导入'),
                        onPress: () => void confirmTodoistImport(parseResult.parsedProjects),
                    },
                ]
            );
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(localize('Import failed', '导入失败'), String(error), 5200);
        } finally {
            setBackupAction(null);
        }
    }, [buildTodoistSummary, confirmTodoistImport, localize, setBackupAction, showSettingsErrorToast, showSettingsWarning]);

    const handleImportDgt = useCallback(async () => {
        setBackupAction('import');
        try {
            const document = await pickDgtDocument();
            if (!document) return;
            const parseResult = await inspectDgtDocument(document);
            if (!parseResult.valid || !parseResult.preview || !parseResult.parsedData) {
                showSettingsWarning(
                    localize('Import failed', '导入失败'),
                    parseResult.errors[0] || localize('The selected file is not a supported DGT GTD export.', '所选文件不是受支持的 DGT GTD 导出文件。')
                );
                return;
            }
            const parsedData = parseResult.parsedData;
            Alert.alert(
                localize('Import DGT GTD data?', '导入 DGT GTD 数据？'),
                buildDgtSummary(parseResult.preview),
                [
                    { text: localize('Cancel', '取消'), style: 'cancel' },
                    {
                        text: localize('Import', '导入'),
                        onPress: () => void confirmDgtImport(parsedData),
                    },
                ]
            );
        } catch (error) {
            logSettingsError(error);
            showSettingsErrorToast(localize('Import failed', '导入失败'), String(error), 5200);
        } finally {
            setBackupAction(null);
        }
    }, [buildDgtSummary, confirmDgtImport, localize, setBackupAction, showSettingsErrorToast, showSettingsWarning]);

    const handleRestoreRecoverySnapshot = useCallback(async (snapshotName: string) => {
        Alert.alert(
            localize('Restore recovery snapshot?', '恢复快照？'),
            localize(
                `Restore ${formatRecoverySnapshotLabel(snapshotName)}? This will replace current local data.`,
                `恢复 ${formatRecoverySnapshotLabel(snapshotName)}？这将替换当前本地数据。`
            ),
            [
                { text: localize('Cancel', '取消'), style: 'cancel' },
                {
                    text: localize('Restore', '恢复'),
                    style: 'destructive',
                    onPress: async () => {
                        setBackupAction('snapshot');
                        try {
                            await restoreLocalDataSnapshot(snapshotName);
                            await refreshRecoverySnapshots();
                            showToast({
                                title: localize('Restore complete', '恢复完成'),
                                message: localize('Recovery snapshot restored.', '恢复快照已恢复。'),
                                tone: 'success',
                            });
                        } catch (error) {
                            logSettingsError(error);
                            showSettingsErrorToast(localize('Restore failed', '恢复失败'), String(error), 5200);
                        } finally {
                            setBackupAction(null);
                        }
                    },
                },
            ]
        );
    }, [formatRecoverySnapshotLabel, localize, refreshRecoverySnapshots, setBackupAction, showSettingsErrorToast, showToast]);

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
        const path = await ensureLogFilePath();
        if (!path) {
            showToast({
                title: t('settings.debugLogging'),
                message: t('settings.logMissing'),
                tone: 'warning',
            });
            return;
        }
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
        handleClearLog,
        handleImportDgt,
        handleImportTodoist,
        handleRestoreBackup,
        handleRestoreRecoverySnapshot,
        handleShareLog,
        toggleDebugLogging,
    };
}
