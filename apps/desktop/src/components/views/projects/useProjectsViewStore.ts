import { shallow, useTaskStore } from '@mindwtr/core';


export const useProjectsViewStore = () =>
    useTaskStore(
        (state) => ({
            projects: state.projects,
            areas: state.areas,
            addArea: state.addArea,
            updateArea: state.updateArea,
            deleteArea: state.deleteArea,
            reorderAreas: state.reorderAreas,
            reorderProjects: state.reorderProjects,
            addProject: state.addProject,
            updateProject: state.updateProject,
            duplicateProject: state.duplicateProject,
            updateTask: state.updateTask,
            toggleProjectFocus: state.toggleProjectFocus,
            allTasks: state._allTasks,
            highlightTaskId: state.highlightTaskId,
            settings: state.settings,
            focusedProjectCount: state.getDerivedState().focusedProjectCount,
            projectTaskSummaryById: state.getDerivedState().projectTaskSummaryById,
        }),
        shallow
    );
