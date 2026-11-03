import { useMemo } from 'react';
import {
    isTaskVisibleInArea,
    resolveAreaFilterSelection,
    useTaskStore,
    type Area,
    type AreaVisibilityContext,
    type Project,
    type Task,
} from '@mindwtr/core';


export type DesktopAreaVisibility = AreaVisibilityContext & {
    areaById: Map<string, Area>;
    projectById: Map<string, Project>;
};

export type VisibleTaskContext = DesktopAreaVisibility & {

    visibility: DesktopAreaVisibility;

    visibleTasks: Task[];
};


export function useAreaVisibility(): DesktopAreaVisibility {
    const projects = useTaskStore((state) => state.projects);
    const areas = useTaskStore((state) => state.areas);
    const filters = useTaskStore((state) => state.settings?.filters);

    const areaById = useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
    const projectById = useMemo(
        () => new Map(projects.map((project) => [project.id, project])),
        [projects],
    );
    const resolvedAreaFilter = useMemo(
        () => resolveAreaFilterSelection(filters, areas),
        [filters, areas],
    );

    return useMemo(
        () => ({ areaById, projectById, resolvedAreaFilter }),
        [areaById, projectById, resolvedAreaFilter],
    );
}


export function useVisibleTaskContext(): VisibleTaskContext {
    const visibility = useAreaVisibility();
    const tasks = useTaskStore((state) => state.tasks);
    const visibleTasks = useMemo(
        () => tasks.filter((task) => isTaskVisibleInArea(task, visibility)),
        [tasks, visibility],
    );
    return { ...visibility, visibility, visibleTasks };
}
