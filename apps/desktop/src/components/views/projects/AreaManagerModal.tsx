import { DndContext, type DragEndEvent, closestCenter } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { translateWithFallback, type Area, type StoreActionResult } from '@mindwtr/core';
import { useId, type ChangeEventHandler } from 'react';
import { X } from 'lucide-react';
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '../../ui/Dialog';
import { SortableAreaRow } from './SortableRows';
import { AreaColorPicker } from './AreaColorPicker';

type AreaManagerModalProps = {
    sortedAreas: Area[];
    areaSensors: ReturnType<typeof import('@dnd-kit/core').useSensors>;
    onDragEnd: (event: DragEndEvent) => void;
    onDeleteArea: (areaId: string) => void;
    onUpdateArea: (areaId: string, updates: Partial<Area>) => Promise<StoreActionResult> | void;
    newAreaColor: string | undefined;
    onChangeNewAreaColor: (color: string | undefined) => void;
    newAreaName: string;
    onChangeNewAreaName: ChangeEventHandler<HTMLInputElement>;
    onCreateArea: () => void;
    isCreatingArea?: boolean;
    onSortByName: () => void;
    onSortByColor: () => void;
    onClose: () => void;
    t: (key: string) => string;
};

export function AreaManagerModal({
    sortedAreas,
    areaSensors,
    onDragEnd,
    onDeleteArea,
    onUpdateArea,
    newAreaColor,
    onChangeNewAreaColor,
    newAreaName,
    onChangeNewAreaName,
    onCreateArea,
    isCreatingArea = false,
    onSortByName,
    onSortByColor,
    onClose,
    t,
}: AreaManagerModalProps) {
    const titleId = useId();
    const resolveText = (key: string, fallback: string) => {
        return translateWithFallback(t, key, fallback);
    };
    const manageAreasLabel = resolveText('areas.manage', 'Manage Areas');
    const newAreaLabel = resolveText('areas.new', 'New Area');
    const areaNamePlaceholder = resolveText('areas.namePlaceholder', 'Area name');
    const loadingLabel = resolveText('common.loading', 'Loading...');

    return (
        <Dialog
            onClose={onClose}
            labelledBy={titleId}
            placement="top"
            overlayClassName="pt-[15vh]"
            // Capped so a long area list scrolls instead of running off the
            // bottom of the window (#957). overflow stays visible: the row and
            // new-area colour pickers are absolutely positioned menus that have
            // to escape the panel.
            panelClassName="max-w-lg max-h-[70vh] overflow-visible"
        >
            <DialogHeader className="px-4 py-3 border-b flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <h3 id={titleId} className="font-semibold">{manageAreasLabel}</h3>
                    <div className="flex items-center gap-1">
                        <button
                            type="button"
                            onClick={onSortByName}
                            className="text-xs px-2 py-1 rounded border border-border bg-muted/50 hover:bg-muted"
                        >
                            {t('projects.sortByName')}
                        </button>
                        <button
                            type="button"
                            onClick={onSortByColor}
                            className="text-xs px-2 py-1 rounded border border-border bg-muted/50 hover:bg-muted"
                        >
                            {t('projects.sortByColor')}
                        </button>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    className="text-muted-foreground hover:text-foreground p-1 rounded cursor-pointer transition-colors"
                    aria-label="Close"
                >
                    <X className="w-4 h-4" />
                </button>
            </DialogHeader>
            <DialogBody className="p-4">
                <div className="space-y-2">
                    {sortedAreas.length === 0 && (
                        <div className="text-sm text-muted-foreground">
                            {t('projects.noArea')}
                        </div>
                    )}
                    {sortedAreas.length > 0 && (
                        <DndContext sensors={areaSensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                            <SortableContext items={sortedAreas.map((area) => area.id)} strategy={verticalListSortingStrategy}>
                                {sortedAreas.map((area) => (
                                    <SortableAreaRow
                                        key={area.id}
                                        area={area}
                                        onDelete={onDeleteArea}
                                        onUpdateName={(areaId, name) => onUpdateArea(areaId, { name })}
                                        onUpdateColor={(areaId, color) => onUpdateArea(areaId, { color })}
                                        t={t}
                                    />
                                ))}
                            </SortableContext>
                        </DndContext>
                    )}
                </div>
            </DialogBody>
            {/* Stays out of the scroll area so a long list can never push
                the create row out of reach. */}
            <DialogFooter className="mx-4 border-t border-border/50 pt-3 pb-4 space-y-2">
                <label className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                    {newAreaLabel}
                </label>
                <div className="flex items-center gap-2">
                    <AreaColorPicker
                        value={newAreaColor}
                        onChange={onChangeNewAreaColor}
                        title={t('projects.color')}
                        noneLabel={t('projects.colorNone')}
                        customLabel={t('projects.colorCustom')}
                        applyLabel={t('common.ok')}
                        cancelLabel={t('common.cancel')}
                    />
                    <input
                        type="text"
                        value={newAreaName}
                        onChange={onChangeNewAreaName}
                        placeholder={areaNamePlaceholder}
                        className="flex-1 bg-muted/50 border border-border rounded px-2 py-1 text-sm"
                    />
                    <button
                        type="button"
                        onClick={onCreateArea}
                        disabled={isCreatingArea}
                        className="px-3 py-1.5 rounded-md text-sm bg-primary text-primary-foreground hover:bg-primary/90"
                    >
                        {isCreatingArea ? loadingLabel : t('projects.create')}
                    </button>
                </div>
            </DialogFooter>
        </Dialog>
    );
}
