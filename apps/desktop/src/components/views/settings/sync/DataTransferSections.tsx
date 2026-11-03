import { ExternalLink } from 'lucide-react';
import { getDocsGuideUrl } from '@mindwtr/core';
import { useDocumentationLanguage } from '../../../../contexts/language-context';
import { useState } from 'react';
import { SettingsDisclosureCard } from '../SettingRow';
import type { SettingsDataPageProps } from './types';

type BackupSectionProps = Pick<
    SettingsDataPageProps,
    | 't'
    | 'transferAction'
    | 'onExportBackup'
    | 'onExportCsv'
    | 'onExportTaskNotes'
    | 'onRestoreBackup'
    | 'onMergeBackup'
    | 'onAddGettingStartedContent'
>;

type ImportSectionProps = Pick<
    SettingsDataPageProps,
    | 't'
    | 'transferAction'
    | 'onImportTodoist'
    | 'onImportTickTick'
    | 'onImportDgt'
    | 'onImportOmniFocus'
    | 'onImportMindwtrCsv'
>;

function TransferActionButton({
    description,
    label,
    onClick,
    settingsKey,
    statusText,
    disabled,
}: {
    description: string;
    label: string;
    onClick: () => void;
    settingsKey?: string;
    statusText?: string | null;
    disabled: boolean;
}) {
    return (
        <button
            type="button"
            data-settings-key={settingsKey}
            onClick={onClick}
            disabled={disabled}
            className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
            <div>
                <div className="text-sm font-medium text-foreground">{label}</div>
                <div className="text-xs text-muted-foreground">{description}</div>
            </div>
            <div className="text-xs text-muted-foreground">{statusText}</div>
        </button>
    );
}


export function BackupSection({
    onExportBackup,
    onExportCsv,
    onExportTaskNotes,
    onMergeBackup,
    onRestoreBackup,
    onAddGettingStartedContent,
    t,
    transferAction,
}: BackupSectionProps) {
    const disabled = transferAction !== null;
    const [open, setOpen] = useState(false);

    return (
        <SettingsDisclosureCard
            sectionKey="backup"
            title={t.backup}
            description={t.backupDesc}
            open={open}
            onToggle={() => setOpen((prev) => !prev)}
        >
            <TransferActionButton
                disabled={disabled}
                settingsKey="exportBackup"
                label={t.exportBackup}
                description={t.exportBackupDesc}
                statusText={transferAction === 'export' ? t.syncing : null}
                onClick={() => void onExportBackup()}
            />
            <TransferActionButton
                disabled={disabled}
                settingsKey="exportCsv"
                label={t.exportCsv}
                description={t.exportCsvDesc}
                statusText={transferAction === 'export:csv' ? t.syncing : null}
                onClick={() => void onExportCsv()}
            />
            <TransferActionButton
                disabled={disabled}
                settingsKey="exportTaskNotes"
                label={t.exportTaskNotes}
                description={t.exportTaskNotesDesc}
                statusText={transferAction === 'export:tasknotes' ? t.syncing : null}
                onClick={() => void onExportTaskNotes()}
            />
            <TransferActionButton
                disabled={disabled}
                settingsKey="restoreBackup"
                label={t.restoreBackup}
                description={t.restoreBackupDesc}
                statusText={transferAction === 'restore' ? t.syncing : null}
                onClick={() => void onRestoreBackup()}
            />
            <TransferActionButton
                disabled={disabled}
                settingsKey="mergeBackup"
                label={t.mergeBackup}
                description={t.mergeBackupDesc}
                statusText={transferAction === 'merge' ? t.syncing : null}
                onClick={() => void onMergeBackup()}
            />
            <TransferActionButton
                disabled={disabled}
                label={t.gettingStartedContentAction}
                description={t.gettingStartedContentDesc}
                statusText={null}
                onClick={() => void onAddGettingStartedContent()}
            />
        </SettingsDisclosureCard>
    );
}

export function ImportSection({
    onImportDgt,
    onImportMindwtrCsv,
    onImportOmniFocus,
    onImportTickTick,
    onImportTodoist,
    t,
    transferAction,
}: ImportSectionProps) {
    const language = useDocumentationLanguage();
    const disabled = transferAction !== null;
    const [open, setOpen] = useState(false);

    return (
        <SettingsDisclosureCard
            sectionKey="importData"
            title={t.importData}
            description={t.importDataDesc}
            open={open}
            onToggle={() => setOpen((prev) => !prev)}
        >
            <a
                href={getDocsGuideUrl('import/', language)}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 px-4 py-3 text-sm font-medium text-primary hover:underline"
            >
                {t.importSetupGuideTitle}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
            <TransferActionButton
                disabled={disabled}
                settingsKey="importTodoist"
                label={t.importTodoist}
                description={t.importTodoistDesc}
                statusText={transferAction === 'import:todoist' ? t.syncing : null}
                onClick={() => void onImportTodoist()}
            />
            <TransferActionButton
                disabled={disabled}
                settingsKey="importTickTick"
                label={t.importTickTick}
                description={t.importTickTickDesc}
                statusText={transferAction === 'import:ticktick' ? t.syncing : null}
                onClick={() => void onImportTickTick()}
            />
            <TransferActionButton
                disabled={disabled}
                settingsKey="importDgt"
                label={t.importDgt}
                description={t.importDgtDesc}
                statusText={transferAction === 'import:dgt' ? t.syncing : null}
                onClick={() => void onImportDgt()}
            />
            <TransferActionButton
                disabled={disabled}
                settingsKey="importOmniFocus"
                label={t.importOmniFocus}
                description={t.importOmniFocusDesc}
                statusText={transferAction === 'import:omnifocus' ? t.syncing : null}
                onClick={() => void onImportOmniFocus()}
            />
            <TransferActionButton
                disabled={disabled}
                settingsKey="importMindwtrCsv"
                label={t.importMindwtrCsv}
                description={t.importMindwtrCsvDesc}
                statusText={transferAction === 'import:mindwtr-csv' ? t.syncing : null}
                onClick={() => void onImportMindwtrCsv()}
            />
        </SettingsDisclosureCard>
    );
}
