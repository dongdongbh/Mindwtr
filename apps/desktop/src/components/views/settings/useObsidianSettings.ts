import { useCallback, useEffect, useMemo, useState } from 'react';

import {
    parseScanFoldersInput,
    ObsidianService,
} from '../../../lib/obsidian-service';
import { useObsidianStore } from '../../../store/obsidian-store';
import { useUiStore } from '../../../store/ui-store';

type UseObsidianSettingsOptions = {
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
    isTauri,
    showSaved,
    selectVaultFolderTitle,
    messages,
}: UseObsidianSettingsOptions) => {
    const showToast = useUiStore((state) => state.showToast);
    const config = useObsidianStore((state) => state.config);
    const hasVaultMarker = useObsidianStore((state) => state.hasVaultMarker);
    const isScanning = useObsidianStore((state) => state.isScanning);
    const refreshConfig = useObsidianStore((state) => state.refreshConfig);
    const saveConfig = useObsidianStore((state) => state.saveConfig);
    const removeConfig = useObsidianStore((state) => state.removeConfig);
    const scan = useObsidianStore((state) => state.scan);

    const [vaultPath, setVaultPath] = useState('');
    const [enabled, setEnabled] = useState(false);
    const [scanFoldersText, setScanFoldersText] = useState('/');
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        void refreshConfig();
    }, [refreshConfig]);

    useEffect(() => {
        setVaultPath(config.vaultPath ?? '');
        setEnabled(config.enabled);
        setScanFoldersText(config.scanFolders.join('\n'));
    }, [config.enabled, config.scanFolders, config.vaultPath]);

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
            });
            showSaved();
        } catch (error) {
            showToast(toErrorMessage(error, messages.saveFailed), 'error');
        } finally {
            setIsSaving(false);
        }
    }, [enabled, messages.saveFailed, saveConfig, scanFoldersText, showSaved, showToast, vaultPath]);

    const handleRemove = useCallback(async () => {
        try {
            await removeConfig();
            setVaultPath('');
            setEnabled(false);
            setScanFoldersText('/');
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
        setObsidianVaultPath: setVaultPath,
        obsidianEnabled: enabled,
        setObsidianEnabled: setEnabled,
        obsidianScanFoldersText: scanFoldersText,
        setObsidianScanFoldersText: setScanFoldersText,
        obsidianLastScannedAt: config.lastScannedAt,
        obsidianHasVaultMarker: hasVaultMarker,
        obsidianVaultWarning: vaultWarning,
        isSavingObsidian: isSaving,
        isScanningObsidian: isScanning,
        onBrowseObsidianVault: handleBrowseVault,
        onSaveObsidian: handleSave,
        onRemoveObsidian: handleRemove,
        onRescanObsidian: handleRescan,
    };
};
