import { useMemo } from 'react';
import { AREA_FILTER_NONE, shallow, useTaskStore, type Area, type Task } from '@mindwtr/core';

const EMPTY_PROJECT_TASKS: readonly Task[] = [];

// Narrow store reads for the project workspace. Mirrors useProjectsViewStore:
// the workspace subscribes per-slice/per-action (shallow) instead of receiving
// ~30 store values re-threaded through ProjectsView (arch review 2026-07-20 #8).
export const useProjectWorkspaceStore = (selectedProjectId: string | null) => {
    const store = useTaskStore(
        (state) => ({
            projects: state.projects,
            sections: state.sections,
            areas: state.areas,
            allTasks: state._allTasks,
            settings: state.settings,
            undoNotificationsEnabled: state.settings?.undoNotificationsEnabled !== false,
            getDerivedState: state.getDerivedState,
            addSection: state.addSection,
            updateSection: state.updateSection,
            deleteSection: state.deleteSection,
            reorderSections: state.reorderSections,
            reorderProjectTasks: state.reorderProjectTasks,
            updateProject: state.updateProject,
            deleteProject: state.deleteProject,
            restoreProject: state.restoreProject,
            updateTask: state.updateTask,
            restoreTask: state.restoreTask,
            batchMoveTasks: state.batchMoveTasks,
            batchDeleteTasks: state.batchDeleteTasks,
            batchUpdateTasks: state.batchUpdateTasks,
            setHighlightTask: state.setHighlightTask,
        }),
        shallow,
    );

    const { allContexts, allTags } = store.getDerivedState();
    const allTokens = useMemo(
        () => Array.from(new Set([...allContexts, ...allTags])).sort(),
        [allContexts, allTags],
    );
    const selectedProjectTasks = useMemo<readonly Task[]>(
        // The derived map uses the visible projection, which drops archived tasks.
        () => (selectedProjectId
            ? store.allTasks.filter((task) => task.projectId === selectedProjectId && !task.deletedAt)
            : EMPTY_PROJECT_TASKS),
        [store.allTasks, selectedProjectId],
    );

    const { sortedAreas, areaById } = useMemo(() => {
        const sorted = [...store.areas].sort((a, b) => a.order - b.order);
        return {
            sortedAreas: sorted,
            areaById: new Map<string, Area>(sorted.map((area) => [area.id, area])),
        };
    }, [store.areas]);

    return {
        ...store,
        allTokens,
        selectedProjectTasks,
        sortedAreas,
        areaById,
        noAreaId: AREA_FILTER_NONE,
    };
};
