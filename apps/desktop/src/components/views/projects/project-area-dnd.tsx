import type { ReactNode } from 'react';
import { closestCenter, pointerWithin, useDroppable, type CollisionDetection } from '@dnd-kit/core';
import { cn } from '../../../lib/utils';
import type { ProjectAreaSection } from './project-area-collapse';

const PROJECT_AREA_CONTAINER_PREFIX = 'project-area:';


export const getProjectAreaContainerId = (section: ProjectAreaSection, areaId: string) =>
    `${PROJECT_AREA_CONTAINER_PREFIX}${section}:${areaId}`;

export const getProjectAreaContainerInfo = (
    containerId: string,
): { section: ProjectAreaSection; areaId: string } | null => {
    if (!containerId.startsWith(PROJECT_AREA_CONTAINER_PREFIX)) return null;
    const rest = containerId.slice(PROJECT_AREA_CONTAINER_PREFIX.length);
    const separator = rest.indexOf(':');
    if (separator === -1) return null;
    const section = rest.slice(0, separator) as ProjectAreaSection;
    const areaId = rest.slice(separator + 1);
    if (!areaId || (section !== 'active' && section !== 'deferred' && section !== 'archived')) return null;
    return { section, areaId };
};

export const getProjectAreaIdFromContainer = (containerId: string) =>
    getProjectAreaContainerInfo(containerId)?.areaId ?? null;


export const projectAreaCollisionDetection: CollisionDetection = (args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
        const rowCollisions = pointerCollisions.filter(
            (collision) => getProjectAreaIdFromContainer(String(collision.id)) === null
        );
        return rowCollisions.length > 0 ? rowCollisions : pointerCollisions;
    }
    return closestCenter(args);
};

type ComputeProjectAreaDragResultArgs = {
    activeId: string;
    overId: string;
    projectIdsByArea: Map<string, string[]>;
    projectAreaById: Map<string, string>;
};

export type ProjectAreaDragResult = {
    sourceAreaId: string;
    destinationAreaId: string;
    nextSourceIds: string[];
    nextDestinationIds: string[];
    movedProjectId: string;
    movedAcrossAreas: boolean;
};

const reorderIds = (items: string[], fromIndex: number, toIndex: number) => {
    const next = [...items];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    return next;
};

export function computeProjectAreaDragResult({
    activeId,
    overId,
    projectIdsByArea,
    projectAreaById,
}: ComputeProjectAreaDragResultArgs): ProjectAreaDragResult | null {
    const sourceAreaId = projectAreaById.get(activeId);
    if (!sourceAreaId) return null;

    const destinationAreaId = projectAreaById.get(overId) ?? getProjectAreaIdFromContainer(overId);
    if (!destinationAreaId) return null;

    const sourceIds = projectIdsByArea.get(sourceAreaId) ?? [];
    const destinationIds = projectIdsByArea.get(destinationAreaId) ?? [];

    if (sourceAreaId === destinationAreaId) {
        const fromIndex = sourceIds.indexOf(activeId);
        if (fromIndex === -1) return null;
        const overIndex = projectAreaById.has(overId) ? sourceIds.indexOf(overId) : -1;
        const toIndex = overIndex === -1 ? sourceIds.length - 1 : overIndex;
        if (toIndex === -1 || fromIndex === toIndex) return null;
        const reordered = reorderIds(sourceIds, fromIndex, toIndex);
        return {
            sourceAreaId,
            destinationAreaId,
            nextSourceIds: reordered,
            nextDestinationIds: reordered,
            movedProjectId: activeId,
            movedAcrossAreas: false,
        };
    }

    const sourceIndex = sourceIds.indexOf(activeId);
    if (sourceIndex === -1) return null;

    const nextSourceIds = sourceIds.filter((id) => id !== activeId);
    const nextDestinationIds = [...destinationIds];
    const overIndex = projectAreaById.has(overId) ? nextDestinationIds.indexOf(overId) : -1;
    const insertIndex = overIndex === -1 ? nextDestinationIds.length : overIndex;
    nextDestinationIds.splice(insertIndex, 0, activeId);

    return {
        sourceAreaId,
        destinationAreaId,
        nextSourceIds,
        nextDestinationIds,
        movedProjectId: activeId,
        movedAcrossAreas: true,
    };
}

type ProjectAreaDropZoneProps = {
    section: ProjectAreaSection;
    areaId: string;
    className?: string;
    children: ReactNode;
};

export function ProjectAreaDropZone({ section, areaId, className, children }: ProjectAreaDropZoneProps) {
    const { setNodeRef, isOver } = useDroppable({
        id: getProjectAreaContainerId(section, areaId),
        data: { zone: 'projectArea', section, areaId },
    });
    return (
        <div ref={setNodeRef} className={cn(className, isOver && 'ring-2 ring-primary/40 rounded-lg')}>
            {children}
        </div>
    );
}
