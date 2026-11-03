import { ClipboardCheck, Download } from 'lucide-react';
import { tFallback, type Area, type Project, type TaskEnergyLevel, type TaskMoveDestination, type TaskStatus } from '@mindwtr/core';
import { DestinationSelector } from '../../ui/DestinationSelector';

type ListBulkActionsProps = {
    selectionCount: number;
    currentStatus?: TaskStatus | 'all';
    onMoveToStatus: (status: TaskStatus) => void;
    onMoveToSomedaySection?: () => void;
    onMoveToDestination?: (destination: TaskMoveDestination) => void;
    projects?: Project[];
    areas?: Area[];
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
    onMoveToSomedaySection,
    onMoveToDestination,
    projects = [],
    areas = [],
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
    const statusLabel = tFallback(t, 'bulk.organizeStatus', 'Status');
    const energyLabelRaw = t('taskEdit.energyLevel');
    const energyLabel = energyLabelRaw === 'taskEdit.energyLevel' ? 'Energy Level' : energyLabelRaw;
    const removeTagLabelRaw = t('bulk.removeTag');
    const removeTagLabel = removeTagLabelRaw === 'bulk.removeTag' ? 'Remove tag' : removeTagLabelRaw;
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
                aria-label={statusLabel}
            >
                <option value="">{statusLabel}</option>
                {bulkStatusOptions.map((status) => (
                    <option key={status} value={status}>
                        {t(`status.${status}`)}
                    </option>
                ))}
            </select>
            {onMoveToSomedaySection && (
                <button
                    type="button"
                    onClick={onMoveToSomedaySection}
                    className="rounded border border-border bg-muted/50 px-2 py-1 text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                    {tFallback(t, 'viewSections.moveToSection', 'Move to section…')}
                </button>
            )}
            {onMoveToDestination && (
                <DestinationSelector
                    projects={projects}
                    areas={areas}
                    value={null}
                    onChange={onMoveToDestination}
                    destinationLabel={tFallback(t, 'task.destination', 'Destination')}
                    projectsLabel={tFallback(t, 'projects.title', 'Projects')}
                    areasLabel={tFallback(t, 'areas.manage', 'Areas')}
                    deferredLabel={tFallback(t, 'projects.deferredSection', 'Someday / Waiting')}
                    noneLabel={tFallback(t, 'common.none', 'None')}
                    searchPlaceholder={tFallback(t, 'common.search', 'Search')}
                    noMatchesLabel={tFallback(t, 'common.noMatches', 'No matches')}
                    createProjectLabel={tFallback(t, 'projects.new', 'New project')}
                    createAreaLabel={tFallback(t, 'areas.new', 'New area')}
                    controlClassName="hover:bg-muted transition-colors gap-2"
                />
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
