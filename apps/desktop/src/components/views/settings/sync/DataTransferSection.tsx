import { RefreshCw } from 'lucide-react';
import type { SettingsSyncPageProps } from './types';

type DataTransferSectionProps = Pick<
    SettingsSyncPageProps,
    | 't'
    | 'transferAction'
    | 'onExportBackup'
    | 'onRestoreBackup'
    | 'onImportTodoist'
    | 'onImportDgt'
    | 'onImportOmniFocus'
>;

function TransferActionButton({
    description,
    label,
    onClick,
    statusText,
    disabled,
}: {
    description: string;
    label: string;
    onClick: () => void;
    statusText?: string | null;
    disabled: boolean;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className="w-full flex items-center justify-between rounded-md border border-border px-3 py-2 text-left hover:bg-muted/50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
            <div>
                <div className="text-sm font-medium text-foreground">{label}</div>
                <div className="text-xs text-muted-foreground">{description}</div>
            </div>
            <div className="text-xs text-muted-foreground">{statusText}</div>
        </button>
    );
}

export function DataTransferSection({
    onExportBackup,
    onImportDgt,
    onImportOmniFocus,
    onImportTodoist,
    onRestoreBackup,
    t,
    transferAction,
}: DataTransferSectionProps) {
    const disabled = transferAction !== null;

    return (
        <section className="space-y-3">
            <h2 className="text-lg font-semibold flex items-center gap-2">
                <RefreshCw className="w-5 h-5" />
                {t.dataTransfer}
            </h2>
            <div className="bg-card border border-border rounded-lg p-6 space-y-3">
                <p className="text-sm text-muted-foreground">{t.dataTransferDesc}</p>
                <div className="space-y-2">
                    <TransferActionButton
                        disabled={disabled}
                        label={t.exportBackup}
                        description={t.exportBackupDesc}
                        statusText={transferAction === 'export' ? t.syncing : null}
                        onClick={() => void onExportBackup()}
                    />
                    <TransferActionButton
                        disabled={disabled}
                        label={t.restoreBackup}
                        description={t.restoreBackupDesc}
                        statusText={transferAction === 'restore' ? t.syncing : null}
                        onClick={() => void onRestoreBackup()}
                    />
                    <TransferActionButton
                        disabled={disabled}
                        label={t.importTodoist}
                        description={t.importTodoistDesc}
                        statusText={transferAction === 'import' ? t.syncing : null}
                        onClick={() => void onImportTodoist()}
                    />
                    <TransferActionButton
                        disabled={disabled}
                        label={t.importDgt}
                        description={t.importDgtDesc}
                        statusText={transferAction === 'import' ? t.syncing : null}
                        onClick={() => void onImportDgt()}
                    />
                    <TransferActionButton
                        disabled={disabled}
                        label={t.importOmniFocus}
                        description={t.importOmniFocusDesc}
                        statusText={transferAction === 'import' ? t.syncing : null}
                        onClick={() => void onImportOmniFocus()}
                    />
                </div>
            </div>
        </section>
    );
}
