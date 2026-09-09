import { ClipboardCheck, Download } from 'lucide-react';
import { tFallback, type TaskStatus } from '@mindwtr/core';

type ReviewBulkActionsProps = {
    selectionCount: number;
    moveToStatus: TaskStatus | '';
    onMoveToStatus: (status: TaskStatus) => Promise<void> | void;
    onChangeMoveToStatus: (status: TaskStatus) => void;
    onBulkOrganize?: () => void;
    onAddTag: () => void;
    onRemoveTag?: () => void;
    disableRemoveTag?: boolean;
    onExportCsv?: () => void;
    isExporting?: boolean;
    onDelete: () => void;
    statusOptions: TaskStatus[];
    t: (key: string) => string;
};

export function ReviewBulkActions({
    selectionCount,
    moveToStatus,
    onMoveToStatus,
    onChangeMoveToStatus,
    onBulkOrganize,
    onAddTag,
    onRemoveTag,
    disableRemoveTag = false,
    onExportCsv,
    isExporting = false,
    onDelete,
    statusOptions,
    t,
}: ReviewBulkActionsProps) {
    if (selectionCount === 0) return null;

    return (
        <div className="flex flex-wrap items-center gap-3 bg-card border border-border rounded-lg p-3">
            <div className="flex items-center gap-3">
                <span className="text-sm text-muted-foreground">
                    {selectionCount} {t('bulk.selected')}
                </span>
                <div className="flex items-center gap-2">
                    <label htmlFor="review-bulk-move" className="text-xs text-muted-foreground">
                        {t('bulk.moveTo')}
                    </label>
                    <select
                        id="review-bulk-move"
                        value={moveToStatus}
                        onChange={async (e) => {
                            const nextStatus = e.target.value as TaskStatus;
                            onChangeMoveToStatus(nextStatus);
                            await onMoveToStatus(nextStatus);
                        }}
                        className="text-xs bg-muted/50 text-foreground border border-border rounded px-2 py-1 hover:bg-muted transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40"
                    >
                        <option value="" disabled>
                            {t('bulk.moveTo')}
                        </option>
                        {statusOptions.map((status) => (
                            <option key={status} value={status}>
                                {t(`status.${status}`)}
                            </option>
                        ))}
                    </select>
                </div>
            </div>
            <div className="flex items-center gap-2">
                {onBulkOrganize && (
                    <button
                        onClick={onBulkOrganize}
                        className="inline-flex items-center gap-1.5 rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                        aria-label={tFallback(t, 'bulk.organize', 'Bulk organize')}
                    >
                        <ClipboardCheck className="h-3.5 w-3.5" aria-hidden="true" />
                        {tFallback(t, 'bulk.organize', 'Bulk organize')}
                    </button>
                )}
                <button
                    onClick={onAddTag}
                    className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors"
                >
                    {t('bulk.addTag')}
                </button>
                {onRemoveTag && (
                    <button
                        onClick={onRemoveTag}
                        disabled={disableRemoveTag}
                        className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {t('bulk.removeTag')}
                    </button>
                )}
                {onExportCsv && (
                    <button
                        type="button"
                        onClick={onExportCsv}
                        disabled={isExporting}
                        aria-busy={isExporting}
                        className="inline-flex items-center gap-1.5 rounded bg-muted/50 px-2 py-1 text-xs transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label={tFallback(t, 'bulk.exportCsv', 'Export selected tasks as CSV')}
                    >
                        <Download className="h-3.5 w-3.5" aria-hidden="true" />
                        {tFallback(t, 'bulk.exportCsv', 'Export selected tasks as CSV')}
                    </button>
                )}
                <button
                    onClick={onDelete}
                    className="text-xs px-2 py-1 rounded bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
                >
                    {t('bulk.delete')}
                </button>
            </div>
        </div>
    );
}
