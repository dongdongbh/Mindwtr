import { ClipboardCheck, Download } from 'lucide-react';
import { tFallback, type TaskEnergyLevel, type TaskStatus } from '@mindwtr/core';

type ListBulkActionsProps = {
    selectionCount: number;
    currentStatus?: TaskStatus | 'all';
    onMoveToStatus: (status: TaskStatus) => void;
    onAssignArea?: (areaId: string | null) => void;
    areaOptions?: Array<{ id: string; name: string }>;
    onAssignEnergyLevel?: (energyLevel: TaskEnergyLevel) => void;
    onBulkOrganize?: () => void;
    onAddTag: () => void;
    onRemoveTag?: () => void;
    disableRemoveTag?: boolean;
    onAddContext: () => void;
    onRemoveContext?: () => void;
    disableRemoveContext?: boolean;
    onExportCsv?: () => void;
    isExporting?: boolean;
    onDelete: () => void;
    isDeleting?: boolean;
    t: (key: string) => string;
};

const BULK_STATUS_OPTIONS: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'reference', 'done'];
const BULK_ENERGY_OPTIONS: TaskEnergyLevel[] = ['low', 'medium', 'high'];

export function getListBulkMoveStatusOptions(currentStatus?: TaskStatus | 'all'): TaskStatus[] {
    if (currentStatus !== 'done') return BULK_STATUS_OPTIONS;
    return [...BULK_STATUS_OPTIONS.filter((status) => status !== currentStatus), 'archived'];
}

export function ListBulkActions({
    selectionCount,
    currentStatus,
    onMoveToStatus,
    onAssignArea,
    areaOptions,
    onAssignEnergyLevel,
    onBulkOrganize,
    onAddTag,
    onRemoveTag,
    disableRemoveTag = false,
    onAddContext,
    onRemoveContext,
    disableRemoveContext = false,
    onExportCsv,
    isExporting = false,
    onDelete,
    isDeleting = false,
    t,
}: ListBulkActionsProps) {
    if (selectionCount === 0) return null;
    const areaLabelRaw = t('projects.areaLabel');
    const areaLabel = areaLabelRaw === 'projects.areaLabel' ? 'Area' : areaLabelRaw;
    const noAreaLabelRaw = t('taskEdit.noAreaOption');
    const noAreaLabel = noAreaLabelRaw === 'taskEdit.noAreaOption' ? 'No area' : noAreaLabelRaw;
    const moveToLabelRaw = t('bulk.moveTo');
    const moveToLabel = moveToLabelRaw === 'bulk.moveTo' ? 'Move to' : moveToLabelRaw;
    const energyLabelRaw = t('taskEdit.energyLevel');
    const energyLabel = energyLabelRaw === 'taskEdit.energyLevel' ? 'Energy Level' : energyLabelRaw;
    const removeTagLabelRaw = t('bulk.removeTag');
    const removeTagLabel = removeTagLabelRaw === 'bulk.removeTag' ? 'Remove tag' : removeTagLabelRaw;
    const hasAreaAssignment = Boolean(onAssignArea) && (areaOptions?.length ?? 0) > 0;
    const bulkStatusOptions = getListBulkMoveStatusOptions(currentStatus);

    return (
        <div className="flex flex-wrap items-center gap-2 bg-card border border-border rounded-lg p-3">
            <span className="text-sm text-muted-foreground">
                {selectionCount} {t('bulk.selected')}
            </span>
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
            <select
                defaultValue=""
                onChange={(event) => {
                    const value = event.currentTarget.value as TaskStatus | '';
                    if (!value) return;
                    onMoveToStatus(value);
                    event.currentTarget.value = '';
                }}
                className="text-xs px-2 py-1 rounded bg-muted/50 border border-border hover:bg-muted transition-colors"
                aria-label={moveToLabel}
            >
                <option value="">{moveToLabel}</option>
                {bulkStatusOptions.map((status) => (
                    <option key={status} value={status}>
                        {t(`status.${status}`)}
                    </option>
                ))}
            </select>
            {hasAreaAssignment && (
                <select
                    defaultValue=""
                    onChange={(event) => {
                        const value = event.currentTarget.value;
                        if (!value || !onAssignArea) return;
                        onAssignArea(value === '__NO_AREA__' ? null : value);
                        event.currentTarget.value = '';
                    }}
                    className="text-xs px-2 py-1 rounded bg-muted/50 border border-border hover:bg-muted transition-colors"
                    aria-label={areaLabel}
                >
                    <option value="">{areaLabel}</option>
                    <option value="__NO_AREA__">{noAreaLabel}</option>
                    {(areaOptions ?? []).map((area) => (
                        <option key={area.id} value={area.id}>
                            {area.name}
                        </option>
                    ))}
                </select>
            )}
            {onAssignEnergyLevel && (
                <select
                    defaultValue=""
                    onChange={(event) => {
                        const value = event.currentTarget.value as TaskEnergyLevel | '';
                        if (!value) return;
                        onAssignEnergyLevel(value);
                        event.currentTarget.value = '';
                    }}
                    className="text-xs px-2 py-1 rounded bg-muted/50 border border-border hover:bg-muted transition-colors"
                    aria-label={energyLabel}
                >
                    <option value="">{energyLabel}</option>
                    {BULK_ENERGY_OPTIONS.map((energyLevel) => (
                        <option key={energyLevel} value={energyLevel}>
                            {t(`energyLevel.${energyLevel}`)}
                        </option>
                    ))}
                </select>
            )}
            <button
                onClick={onAddTag}
                className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors"
                aria-label={t('bulk.addTag')}
            >
                {t('bulk.addTag')}
            </button>
            {onRemoveTag && (
                <button
                    onClick={onRemoveTag}
                    disabled={disableRemoveTag}
                    className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label={removeTagLabel}
                >
                    {removeTagLabel}
                </button>
            )}
            <button
                onClick={onAddContext}
                className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors"
                aria-label={t('bulk.addContext')}
            >
                {t('bulk.addContext')}
            </button>
            {onRemoveContext && (
                <button
                    onClick={onRemoveContext}
                    disabled={disableRemoveContext}
                    className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label={t('bulk.removeContext')}
                >
                    {t('bulk.removeContext')}
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
                className="text-xs px-2 py-1 rounded bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                aria-label={t('bulk.delete')}
                disabled={isDeleting}
                aria-busy={isDeleting}
            >
                {t('bulk.delete')}
            </button>
        </div>
    );
}
