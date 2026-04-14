import type { Area, Project, Section, Task } from '@mindwtr/core';
import { shallow, useTaskStore } from '@mindwtr/core';
import { useUiStore } from '../../store/ui-store';

const EMPTY_PROJECTS: Project[] = [];
const EMPTY_SECTIONS: Section[] = [];
const EMPTY_AREAS: Area[] = [];

type UseTaskItemStoreStateParams = {
    task: Task;
    propProject?: Project;
    isEditing: boolean;
};

export const useTaskItemStoreState = ({ task, propProject, isEditing }: UseTaskItemStoreStateParams) =>
    useTaskStore(
        (state) => {
            const derived = state.getDerivedState();
            const project = propProject ?? (task.projectId ? derived.projectMap.get(task.projectId) : undefined);
            const projectArea = project?.areaId
                ? state.areas.find((area) => area.id === project.areaId)
                : undefined;
            const taskArea = !task.projectId && task.areaId
                ? state.areas.find((area) => area.id === task.areaId)
                : undefined;

            return {
            updateTask: state.updateTask,
            deleteTask: state.deleteTask,
            moveTask: state.moveTask,
            projects: isEditing ? state.projects : EMPTY_PROJECTS,
            sections: isEditing ? state.sections : EMPTY_SECTIONS,
            areas: isEditing ? state.areas : EMPTY_AREAS,
            project,
            projectArea,
            taskArea,
            settings: state.settings,
            focusedCount: derived.focusedCount,
            duplicateTask: state.duplicateTask,
            resetTaskChecklist: state.resetTaskChecklist,
            restoreTask: state.restoreTask,
            highlightTaskId: state.highlightTaskId,
            setHighlightTask: state.setHighlightTask,
            addProject: state.addProject,
            addArea: state.addArea,
            addSection: state.addSection,
            lockEditing: state.lockEditing,
            unlockEditing: state.unlockEditing,
            };
        },
        shallow
    );

export const useTaskItemUiState = (taskId: string) =>
    useUiStore(
        (state) => ({
            setProjectView: state.setProjectView,
            editingTaskId: state.editingTaskId,
            setEditingTaskId: state.setEditingTaskId,
            isTaskExpanded: Boolean(state.expandedTaskIds[taskId]),
            setTaskExpanded: state.setTaskExpanded,
            toggleTaskExpanded: state.toggleTaskExpanded,
            showToast: state.showToast,
        }),
        shallow
    );
