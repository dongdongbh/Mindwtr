import { useCallback, useEffect, useMemo, useState } from 'react';

import {
    parseScanFoldersInput,
    ObsidianService,
} from '../../../lib/obsidian-service';
import { useObsidianStore } from '../../../store/obsidian-store';
import { useUiStore } from '../../../store/ui-store';

type UseObsidianSettingsOptions = {
    loadEnabled?: boolean;
    isTauri: boolean;
    showSaved: () => void;
    selectVaultFolderTitle: string;
    messages: {
        missingMarker: string;
        chooseFailed: string;
        saveFailed: string;
        removeFailed: string;
        scanFailed: string;
        scanSuccess: string;
    };
};

const toErrorMessage = (error: unknown, fallback: string): string => {
    if (error instanceof Error && error.message.trim()) return error.message.trim();
    const text = String(error || '').trim();
    return text || fallback;
};

export const useObsidianSettings = ({
    loadEnabled = true,
    isTauri,
    showSaved,
    selectVaultFolderTitle,
    messages,
}: UseObsidianSettingsOptions) => {
    const showToast = useUiStore((state) => state.showToast);
    const config = useObsidianStore((state) => state.config);
    const hasVaultMarker = useObsidianStore((state) => state.hasVaultMarker);
    const isScanning = useObsidianStore((state) => state.isScanning);
    const isWatching = useObsidianStore((state) => state.isWatching);
    const watcherError = useObsidianStore((state) => state.watcherError);
    const refreshConfig = useObsidianStore((state) => state.refreshConfig);
    const saveConfig = useObsidianStore((state) => state.saveConfig);
    const removeConfig = useObsidianStore((state) => state.removeConfig);
    const scan = useObsidianStore((state) => state.scan);

    const [vaultPath, setVaultPath] = useState('');
    const [enabled, setEnabled] = useState(false);
    const [scanFoldersText, setScanFoldersText] = useState('/');
    const [inboxFile, setInboxFile] = useState('Mindwtr/Inbox.md');
    const [taskNotesIncludeArchived, setTaskNotesIncludeArchived] = useState(false);
    const [dataviewMetadataEnabled, setDataviewMetadataEnabled] = useState(false);
    const [newTaskFormat, setNewTaskFormat] = useState<'auto' | 'inline' | 'tasknotes'>('auto');
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        if (!loadEnabled) return;
        void refreshConfig();
    }, [loadEnabled, refreshConfig]);

    useEffect(() => {
        setVaultPath(config.vaultPath ?? '');
        setEnabled(config.enabled);
        setScanFoldersText(config.scanFolders.join('\n'));
        setInboxFile(config.inboxFile);
        setTaskNotesIncludeArchived(config.taskNotesIncludeArchived);
        setDataviewMetadataEnabled(config.dataviewMetadataEnabled);
        setNewTaskFormat(config.newTaskFormat);
    }, [config.dataviewMetadataEnabled, config.enabled, config.inboxFile, config.newTaskFormat, config.scanFolders, config.taskNotesIncludeArchived, config.vaultPath]);

    const hasConfiguredVault = Boolean((vaultPath || '').trim());

    const vaultWarning = useMemo(() => {
        if (!hasConfiguredVault) return null;
        if (hasVaultMarker === null || hasVaultMarker) return null;
        return messages.missingMarker;
    }, [hasConfiguredVault, hasVaultMarker, messages.missingMarker]);

    const handleBrowseVault = useCallback(async () => {
        if (!isTauri) return;
        try {
            const selected = await ObsidianService.selectVaultFolder(selectVaultFolderTitle);
            if (!selected) return;
            setVaultPath(selected);
            const inspection = await ObsidianService.inspectVault(selected);
            if (inspection.hasObsidianDir === false) {
                showToast(messages.missingMarker, 'info', 5000);
            }
        } catch (error) {
            showToast(toErrorMessage(error, messages.chooseFailed), 'error');
        }
    }, [isTauri, messages.chooseFailed, messages.missingMarker, selectVaultFolderTitle, showToast]);

    const handleSave = useCallback(async () => {
        setIsSaving(true);
        try {
            await saveConfig({
                vaultPath: vaultPath.trim() || null,
                enabled,
                scanFolders: parseScanFoldersInput(scanFoldersText),
                inboxFile,
                taskNotesIncludeArchived,
                dataviewMetadataEnabled,
                newTaskFormat,
            });
            showSaved();
        } catch (error) {
            showToast(toErrorMessage(error, messages.saveFailed), 'error');
        } finally {
            setIsSaving(false);
        }
    }, [dataviewMetadataEnabled, enabled, inboxFile, messages.saveFailed, newTaskFormat, saveConfig, scanFoldersText, showSaved, showToast, taskNotesIncludeArchived, vaultPath]);

    const handleRemove = useCallback(async () => {
        try {
            await removeConfig();
            setVaultPath('');
            setEnabled(false);
            setScanFoldersText('/');
            setInboxFile('Mindwtr/Inbox.md');
            setTaskNotesIncludeArchived(false);
            setDataviewMetadataEnabled(false);
            setNewTaskFormat('auto');
            showSaved();
        } catch (error) {
            showToast(toErrorMessage(error, messages.removeFailed), 'error');
        }
    }, [messages.removeFailed, removeConfig, showSaved, showToast]);

    const handleRescan = useCallback(async () => {
        try {
            await scan();
            const { error, warnings } = useObsidianStore.getState();
            if (error) {
                showToast(error, 'error');
                return;
            }
            if (warnings.length > 0) {
                showToast(warnings[0], 'info', 6000);
            } else {
                showToast(messages.scanSuccess, 'success');
            }
        } catch (error) {
            showToast(toErrorMessage(error, messages.scanFailed), 'error');
        }
    }, [messages.scanFailed, messages.scanSuccess, scan, showToast]);

    return {
        obsidianVaultPath: vaultPath,
        onObsidianVaultPathChange: setVaultPath,
        obsidianEnabled: enabled,
        onObsidianEnabledChange: setEnabled,
        obsidianScanFoldersText: scanFoldersText,
        onObsidianScanFoldersTextChange: setScanFoldersText,
        obsidianInboxFile: inboxFile,
        onObsidianInboxFileChange: setInboxFile,
        obsidianTaskNotesIncludeArchived: taskNotesIncludeArchived,
        onObsidianTaskNotesIncludeArchivedChange: setTaskNotesIncludeArchived,
        obsidianDataviewMetadataEnabled: dataviewMetadataEnabled,
        onObsidianDataviewMetadataEnabledChange: setDataviewMetadataEnabled,
        obsidianNewTaskFormat: newTaskFormat,
        onObsidianNewTaskFormatChange: setNewTaskFormat,
        obsidianLastScannedAt: config.lastScannedAt,
        obsidianHasVaultMarker: hasVaultMarker,
        obsidianVaultWarning: vaultWarning,
        obsidianIsWatching: isWatching,
        obsidianWatcherError: watcherError,
        isSavingObsidian: isSaving,
        isScanningObsidian: isScanning,
        onBrowseObsidianVault: handleBrowseVault,
        onSaveObsidian: handleSave,
        onRemoveObsidian: handleRemove,
        onRescanObsidian: handleRescan,
    };
};
