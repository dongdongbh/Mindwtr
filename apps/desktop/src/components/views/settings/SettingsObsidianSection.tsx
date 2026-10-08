import { useEffect, useState } from 'react';
import { getDocsGuideUrl, safeFormatDate } from '@mindwtr/core';
import { useDocumentationLanguage } from '../../../contexts/language-context';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';

import { Switch } from '../../ui/Switch';
import { SettingField, SettingRow } from './SettingRow';
import { listDetectedObsidianVaults, type DetectedObsidianVault } from '../../../lib/obsidian-service';

type Labels = {
    obsidianIntegrationGuideTitle: string;
    obsidianVault: string;
    obsidianVaultDesc: string;
    obsidianEnable: string;
    obsidianDetectedVaults: string;
    obsidianVaultPath: string;
    obsidianVaultPathHint: string;
    obsidianScanFolders: string;
    obsidianScanFoldersHint: string;
    obsidianInboxFile: string;
    obsidianInboxFileHint: string;
    obsidianRequiredInlineTag: string;
    obsidianRequiredInlineTagHint: string;
    obsidianDataview: string;
    obsidianDataviewDesc: string;
    obsidianDataviewMetadata: string;
    obsidianDataviewMetadataHint: string;
    obsidianTaskNotes: string;
    obsidianTaskNotesDesc: string;
    obsidianTaskNotesIncludeArchived: string;
    obsidianTaskNotesIncludeArchivedHint: string;
    obsidianNewTaskFormat: string;
    obsidianNewTaskFormatHint: string;
    obsidianNewTaskFormatAuto: string;
    obsidianNewTaskFormatInline: string;
    obsidianNewTaskFormatTaskNotes: string;
    obsidianWatching: string;
    obsidianWatcherUnavailable: string;
    obsidianSave: string;
    obsidianRemove: string;
    obsidianRescan: string;
    obsidianRescanning: string;
    obsidianLastScanned: string;
    obsidianNeverScanned: string;
    obsidianMissingMarker: string;
    browse: string;
};

type SettingsObsidianSectionProps = {
    t: Labels;
    isTauri: boolean;
    obsidianVaultPath: string;
    obsidianEnabled: boolean;
    obsidianScanFoldersText: string;
    obsidianInboxFile: string;
    obsidianTaskNotesIncludeArchived: boolean;
    obsidianDataviewMetadataEnabled: boolean;
    obsidianNewTaskFormat: 'auto' | 'inline' | 'tasknotes';
    obsidianLastScannedAt: string | null;
    obsidianHasVaultMarker: boolean | null;
    obsidianVaultWarning: string | null;
    obsidianIsWatching: boolean;
    obsidianWatcherError: string | null;
    isSavingObsidian: boolean;
    isScanningObsidian: boolean;
    onObsidianVaultPathChange: (value: string) => void;
    onObsidianEnabledChange: (value: boolean) => void;
    onObsidianScanFoldersTextChange: (value: string) => void;
    obsidianRequiredInlineTag: string;
    onObsidianRequiredInlineTagChange: (value: string) => void;
    onObsidianInboxFileChange: (value: string) => void;
    onObsidianTaskNotesIncludeArchivedChange: (value: boolean) => void;
    onObsidianDataviewMetadataEnabledChange: (value: boolean) => void;
    onObsidianNewTaskFormatChange: (value: 'auto' | 'inline' | 'tasknotes') => void;
    onBrowseObsidianVault: () => Promise<void> | void;
    onSaveObsidian: () => Promise<void> | void;
    onRemoveObsidian: () => Promise<void> | void;
    onRescanObsidian: () => Promise<void> | void;
};

export function SettingsObsidianSection({
    t,
    isTauri,
    obsidianVaultPath,
    obsidianEnabled,
    obsidianScanFoldersText,
    obsidianInboxFile,
    obsidianTaskNotesIncludeArchived,
    obsidianDataviewMetadataEnabled,
    obsidianNewTaskFormat,
    obsidianLastScannedAt,
    obsidianHasVaultMarker,
    obsidianVaultWarning,
    obsidianIsWatching,
    obsidianWatcherError,
    isSavingObsidian,
    isScanningObsidian,
    onObsidianVaultPathChange,
    onObsidianEnabledChange,
    onObsidianScanFoldersTextChange,
    onObsidianInboxFileChange,
    obsidianRequiredInlineTag,
    onObsidianRequiredInlineTagChange,
    onObsidianTaskNotesIncludeArchivedChange,
    onObsidianDataviewMetadataEnabledChange,
    onObsidianNewTaskFormatChange,
    onBrowseObsidianVault,
    onSaveObsidian,
    onRemoveObsidian,
    onRescanObsidian,
}: SettingsObsidianSectionProps) {
    const language = useDocumentationLanguage();
    const [open, setOpen] = useState(false);
    const [detectedVaults, setDetectedVaults] = useState<DetectedObsidianVault[]>([]);

    useEffect(() => {
        // Obsidian publishes its vault registry, so known vaults are offered
        // one-click instead of making everyone browse the filesystem.
        if (!open || !isTauri) return;
        let cancelled = false;
        void listDetectedObsidianVaults().then((vaults) => {
            if (!cancelled) setDetectedVaults(vaults);
        });
        return () => {
            cancelled = true;
        };
    }, [open, isTauri]);
    const selectableVaults = detectedVaults.filter((vault) => vault.path !== obsidianVaultPath);

    return (
        <div className="bg-card border border-border rounded-lg">
            <div className="p-4 flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1 space-y-2">
                    <button data-settings-key="obsidianVault" data-settings-section="obsidianVault"
                        type="button"
                        onClick={() => setOpen((prev) => !prev)}
                        aria-expanded={open}
                        className="w-full text-left flex items-center justify-between gap-4"
                    >
                        <div className="min-w-0">
                            <div className="text-sm font-medium">{t.obsidianVault}</div>
                            <p className="text-xs text-muted-foreground mt-1">{t.obsidianVaultDesc}</p>
                        </div>
                        {open ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
                    </button>
                    <a
                        href={getDocsGuideUrl('power-users/obsidian', language)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                    >
                        {t.obsidianIntegrationGuideTitle}
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    </a>
                </div>
                <Switch
                    aria-label={t.obsidianEnable}
                    checked={obsidianEnabled}
                    onCheckedChange={onObsidianEnabledChange}
                />
            </div>
            {open && (
                <div className="border-t border-border p-4 space-y-4">
                    <SettingField settingsKey="obsidianVaultPath" title={t.obsidianVaultPath}>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={obsidianVaultPath}
                                aria-label={t.obsidianVaultPath}
                                onChange={(event) => onObsidianVaultPathChange(event.target.value)}
                                placeholder="/path/to/your/Obsidian/vault"
                                className="flex-1 bg-muted p-2 rounded text-sm font-mono border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                            />
                            <button
                                type="button"
                                onClick={onBrowseObsidianVault}
                                disabled={!isTauri}
                                className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md text-sm font-medium hover:bg-secondary/90 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {t.browse}
                            </button>
                        </div>
                        {selectableVaults.length > 0 && (
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="text-xs text-muted-foreground">{t.obsidianDetectedVaults}</span>
                                {selectableVaults.map((vault) => (
                                    <button
                                        key={vault.path}
                                        type="button"
                                        title={vault.path}
                                        onClick={() => onObsidianVaultPathChange(vault.path)}
                                        className="text-xs px-2.5 py-1 rounded-full border border-border bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                                    >
                                        {vault.name}
                                    </button>
                                ))}
                            </div>
                        )}
                        <p className="text-xs text-muted-foreground">{t.obsidianVaultPathHint}</p>
                        {obsidianVaultWarning && (
                            <p className="text-xs text-warning">
                                {obsidianHasVaultMarker === false ? t.obsidianMissingMarker : obsidianVaultWarning}
                            </p>
                        )}
                    </SettingField>

                    <SettingField settingsKey="obsidianScanFolders" title={t.obsidianScanFolders}>
                        <textarea
                            value={obsidianScanFoldersText}
                            aria-label={t.obsidianScanFolders}
                            onChange={(event) => onObsidianScanFoldersTextChange(event.target.value)}
                            rows={3}
                            className="bg-muted p-2 rounded text-sm font-mono border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                            placeholder={'/\nProjects\nDaily'}
                        />
                        <p className="text-xs text-muted-foreground">{t.obsidianScanFoldersHint}</p>
                    </SettingField>

                    <SettingField settingsKey="obsidianRequiredInlineTag" title={t.obsidianRequiredInlineTag}>
                        <input
                            type="text"
                            className="bg-muted p-2 rounded text-sm border border-border"
                            value={obsidianRequiredInlineTag}
                            aria-label={t.obsidianRequiredInlineTag}
                            onChange={(event) => onObsidianRequiredInlineTagChange(event.target.value)}
                            placeholder="#task"
                        />
                        <p className="text-xs text-muted-foreground">{t.obsidianRequiredInlineTagHint}</p>
                    </SettingField>
                    <SettingField settingsKey="obsidianInboxFile" title={t.obsidianInboxFile}>
                        <input
                            type="text"
                            value={obsidianInboxFile}
                            aria-label={t.obsidianInboxFile}
                            onChange={(event) => onObsidianInboxFileChange(event.target.value)}
                            placeholder="Mindwtr/Inbox.md"
                            className="bg-muted p-2 rounded text-sm font-mono border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                        />
                        <p className="text-xs text-muted-foreground">{t.obsidianInboxFileHint}</p>
                    </SettingField>

                    <div className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-4">
                        <div className="space-y-1">
                            <div className="text-sm font-medium">{t.obsidianDataview}</div>
                            <p className="text-xs text-muted-foreground">{t.obsidianDataviewDesc}</p>
                        </div>

                        <SettingRow settingsKey="obsidianDataviewMetadata" title={t.obsidianDataviewMetadata} description={t.obsidianDataviewMetadataHint}>
                            <Switch
                                aria-label={t.obsidianDataviewMetadata}
                                checked={obsidianDataviewMetadataEnabled}
                                onCheckedChange={onObsidianDataviewMetadataEnabledChange}
                            />
                        </SettingRow>
                    </div>

                    <div className="space-y-3 rounded-lg border border-border/60 bg-muted/30 p-4">
                        <div className="space-y-1">
                            <div className="text-sm font-medium">{t.obsidianTaskNotes}</div>
                            <p className="text-xs text-muted-foreground">{t.obsidianTaskNotesDesc}</p>
                        </div>

                        <SettingRow settingsKey="obsidianTaskNotesIncludeArchived" title={t.obsidianTaskNotesIncludeArchived} description={t.obsidianTaskNotesIncludeArchivedHint}>
                            <Switch
                                aria-label={t.obsidianTaskNotesIncludeArchived}
                                checked={obsidianTaskNotesIncludeArchived}
                                onCheckedChange={onObsidianTaskNotesIncludeArchivedChange}
                            />
                        </SettingRow>

                        <SettingField settingsKey="obsidianNewTaskFormat" title={t.obsidianNewTaskFormat}>
                            <select
                                value={obsidianNewTaskFormat}
                                onChange={(event) => onObsidianNewTaskFormatChange(event.target.value as 'auto' | 'inline' | 'tasknotes')}
                                className="bg-muted p-2 rounded text-sm border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                            >
                                <option value="auto">{t.obsidianNewTaskFormatAuto}</option>
                                <option value="inline">{t.obsidianNewTaskFormatInline}</option>
                                <option value="tasknotes">{t.obsidianNewTaskFormatTaskNotes}</option>
                            </select>
                            <p className="text-xs text-muted-foreground">{t.obsidianNewTaskFormatHint}</p>
                        </SettingField>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="space-y-1">
                            <p className="text-xs text-muted-foreground">
                                {t.obsidianLastScanned}:{' '}
                                <span className="font-medium text-foreground">
                                    {obsidianLastScannedAt ? safeFormatDate(obsidianLastScannedAt, 'PPpp', obsidianLastScannedAt) : t.obsidianNeverScanned}
                                </span>
                            </p>
                            {obsidianWatcherError ? (
                                <p className="text-xs text-warning">
                                    {t.obsidianWatcherUnavailable} {obsidianWatcherError}
                                </p>
                            ) : obsidianIsWatching ? (
                                <p className="text-xs text-muted-foreground">{t.obsidianWatching}</p>
                            ) : null}
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <button
                                type="button"
                                onClick={onRemoveObsidian}
                                disabled={isSavingObsidian || !obsidianVaultPath.trim()}
                                className="px-4 py-2 bg-muted text-muted-foreground rounded-md text-sm font-medium hover:bg-muted/80 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {t.obsidianRemove}
                            </button>
                            <button
                                type="button"
                                onClick={onRescanObsidian}
                                disabled={isScanningObsidian || !obsidianEnabled || !obsidianVaultPath.trim()}
                                className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md text-sm font-medium hover:bg-secondary/90 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {isScanningObsidian ? t.obsidianRescanning : t.obsidianRescan}
                            </button>
                            <button
                                type="button"
                                onClick={onSaveObsidian}
                                disabled={isSavingObsidian}
                                className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 whitespace-nowrap disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed"
                            >
                                {t.obsidianSave}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
