import { useMemo } from 'react';
import { useSensor, useSensors, PointerSensor, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import type { Area, AppData } from '@mindwtr/core';
import { AREA_FILTER_ALL, AREA_FILTER_NONE, resolveAreaFilter } from '../../../lib/area-filter';
import { reportError } from '../../../lib/report-error';
import type { ConfirmationRequestOptions } from '../../../hooks/useConfirmDialog';

type UseAreaSidebarStateParams = {
    areas: Area[];
    settings?: AppData['settings'];
    t: (key: string) => string;
    reorderAreas: (ids: string[]) => Promise<void> | void;
    deleteArea: (id: string) => Promise<unknown> | void;
    setCollapsedAreas: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
    requestConfirmation: (options: ConfirmationRequestOptions) => Promise<boolean>;
    showToast?: (message: string, tone?: 'success' | 'error' | 'info', durationMs?: number) => void;
};

export function useAreaSidebarState({
    areas,
    settings,
    t,
    reorderAreas,
    deleteArea,
    setCollapsedAreas,
    requestConfirmation,
    showToast,
}: UseAreaSidebarStateParams) {
    const ALL_AREAS = AREA_FILTER_ALL;
    const NO_AREA = AREA_FILTER_NONE;
    const selectedArea = useMemo(
        () => resolveAreaFilter(settings?.filters?.areaId, areas),
        [settings?.filters?.areaId, areas],
    );

    const { sortedAreas, areaById } = useMemo(() => {
        const sorted = [...areas].sort((a, b) => a.order - b.order);
        return {
            sortedAreas: sorted,
            areaById: new Map(sorted.map((area) => [area.id, area])),
        };
    }, [areas]);

    const areaFilterLabel = useMemo(() => {
        if (selectedArea === ALL_AREAS) return null;
        if (selectedArea === NO_AREA) return t('projects.noArea');
        return areaById.get(selectedArea)?.name || t('projects.noArea');
    }, [selectedArea, areaById, ALL_AREAS, NO_AREA, t]);

    const areaSensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: { distance: 4 },
        }),
    );

    const toggleAreaCollapse = (areaId: string) => {
        setCollapsedAreas((prev) => ({ ...prev, [areaId]: !prev[areaId] }));
    };

    const handleAreaDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        const oldIndex = sortedAreas.findIndex((area) => area.id === active.id);
        const newIndex = sortedAreas.findIndex((area) => area.id === over.id);
        if (oldIndex === -1 || newIndex === -1) return;
        const reordered = arrayMove(sortedAreas, oldIndex, newIndex).map((area) => area.id);
        void Promise.resolve(reorderAreas(reordered)).catch((error) => {
            reportError('Failed to reorder areas', error);
            showToast?.('Failed to reorder areas', 'error');
        });
    };

    const handleDeleteArea = async (areaId: string) => {
        const confirmed = await requestConfirmation({
            title: t('projects.areaLabel'),
            description: t('projects.deleteConfirm'),
            confirmLabel: t('common.delete') || 'Delete',
            cancelLabel: t('common.cancel') || 'Cancel',
        });
        if (confirmed) {
            deleteArea(areaId);
        }
    };

    return {
        selectedArea,
        sortedAreas,
        areaById,
        areaFilterLabel,
        areaSensors,
        toggleAreaCollapse,
        handleAreaDragEnd,
        handleDeleteArea,
    };
}
