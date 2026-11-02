import { closestCenter, pointerWithin, type CollisionDetection, type KeyboardCoordinateGetter } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { projectAreaCollisionDetection } from './project-area-dnd';
import type { ProjectAreaSection } from './project-area-collapse';

// The whole Projects view shares one DndContext; every draggable declares what it
// is so collision detection and drag-end dispatch can branch per drag type.
export type ProjectsTaskDragData = { type: 'task'; sortable: boolean };
export type ProjectsProjectDragData = { type: 'project'; section: ProjectAreaSection };
export type ProjectsSectionDragData = { type: 'project-section'; projectId: string; sectionId: string };
export type ProjectsDragData = ProjectsTaskDragData | ProjectsProjectDragData | ProjectsSectionDragData;

type DroppableData = {
    type?: string;
    zone?: string;
    section?: ProjectAreaSection;
    areaId?: string;
    projectId?: string;
};

const dataOf = (container: { data: { current?: unknown } }): DroppableData =>
    (container.data.current as DroppableData | undefined) ?? {};

const isSidebarTaskTarget = (data: DroppableData) =>
    (data.type === 'project' || data.zone === 'projectArea') && data.section !== 'archived';

export const projectsViewKeyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
    const activeData = args.context.active?.data.current as ProjectsDragData | undefined;
    if (activeData?.type !== 'project-section') return sortableKeyboardCoordinates(event, args);

    // Task rows between headers must not intercept keyboard section movement.
    const droppableRects = new Map([...args.context.droppableRects].filter(([id]) => {
        const container = args.context.droppableContainers.get(id);
        const data = container ? dataOf(container) : undefined;
        return data?.type === 'project-section' && data.projectId === activeData.projectId;
    }));
    return sortableKeyboardCoordinates(event, {
        ...args,
        context: { ...args.context, droppableRects },
    });
};

export const projectsViewCollisionDetection: CollisionDetection = (args) => {
    const activeData = args.active.data.current as ProjectsDragData | undefined;

    if (activeData?.type === 'project-section') {
        return closestCenter({
            ...args,
            droppableContainers: args.droppableContainers.filter((container) => {
                const data = dataOf(container);
                return data.type === 'project-section' && data.projectId === activeData.projectId;
            }),
        });
    }

    if (activeData?.type === 'project') {
        // Project drags stay inside their own sidebar section, matching the old
        // per-section DndContext boundaries.
        const containers = args.droppableContainers.filter((container) => {
            const data = dataOf(container);
            if (data.type === 'project') return data.section === activeData.section;
            if (data.zone === 'projectArea') return data.section === activeData.section;
            return false;
        });
        return projectAreaCollisionDetection({ ...args, droppableContainers: containers });
    }

    if (activeData?.type === 'task') {
        const containers = args.droppableContainers.filter((container) => {
            const data = dataOf(container);
            if (data.type === 'task') return activeData.sortable;
            if (data.zone === 'section') return activeData.sortable;
            return isSidebarTaskTarget(data);
        });
        const filteredArgs = { ...args, droppableContainers: containers };
        const pointerCollisions = pointerWithin(filteredArgs);
        if (pointerCollisions.length > 0) {
            // Prefer sidebar project rows over the surrounding area block.
            const containerById = new Map(containers.map((container) => [String(container.id), container]));
            const projectRowHits = pointerCollisions.filter((collision) => {
                const container = containerById.get(String(collision.id));
                return container ? dataOf(container).type === 'project' : false;
            });
            return projectRowHits.length > 0 ? projectRowHits : pointerCollisions;
        }
        if (!activeData.sortable) return [];
        const workspaceContainers = containers.filter((container) => {
            const data = dataOf(container);
            return data.type === 'task' || data.zone === 'section';
        });
        return closestCenter({ ...filteredArgs, droppableContainers: workspaceContainers });
    }

    return pointerWithin(args);
};

export type TaskSidebarDropTarget =
    | { kind: 'project'; projectId: string }
    | { kind: 'area'; areaId: string };

export function resolveTaskSidebarDropTarget(
    overId: string,
    overData: unknown,
): TaskSidebarDropTarget | null {
    const data = (overData as DroppableData | undefined) ?? {};
    if (!isSidebarTaskTarget(data)) return null;
    if (data.type === 'project') return { kind: 'project', projectId: overId };
    if (typeof data.areaId === 'string') return { kind: 'area', areaId: data.areaId };
    return null;
}
