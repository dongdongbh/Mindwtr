import type { Area, Project, Section, Task, TaskStatus } from '@mindwtr/core';
import { shallow, useTaskStore } from '@mindwtr/core';
import { useUiStore } from '../../store/ui-store';

const EMPTY_PROJECTS: Project[] = [];
const EMPTY_SECTIONS: Section[] = [];
const EMPTY_AREAS: Area[] = [];
const EMPTY_PROJECT_MAP = new Map<string, Project>();
const EMPTY_TASKS_BY_STATUS = new Map<TaskStatus, Task[]>();
const EMPTY_ID_SET = new Set<string>();

type UseTaskItemStoreStateParams = {
    task: Task;
    propProject?: Project;
    isEditing: boolean;
    hasQuickActionMenu?: boolean;
};

export const useTaskItemStoreState = ({ task, propProject, isEditing, hasQuickActionMenu = false }: UseTaskItemStoreStateParams) =>
    useTaskStore(
        (state) => {
            const derived = state.getDerivedState();
            const includePickers = isEditing || hasQuickActionMenu;
            const includeQuickActionFocusData = hasQuickActionMenu;
            const project = propProject ?? (task.projectId ? derived.projectMap.get(task.projectId) : undefined);
            const mutationProject = task.projectId
                ? state._projectsById.get(task.projectId)
                    ?? state._allProjects.find((candidate) => candidate.id === task.projectId)
                : undefined;
            const section = task.sectionId ? state._sectionsById.get(task.sectionId) : undefined;
            const projectArea = project?.areaId
                ? state.areas.find((area) => area.id === project.areaId)
                : undefined;
            const taskArea = !task.projectId && task.areaId
                ? state.areas.find((area) => area.id === task.areaId)
                : undefined;

            return {
            addTask: state.addTask,
            updateTask: state.updateTask,
            deleteTask: state.deleteTask,
            moveTask: state.moveTask,
            projects: isEditing ? state.projects : EMPTY_PROJECTS,
            sections: isEditing ? state.sections : EMPTY_SECTIONS,
            areas: includePickers ? state.areas : EMPTY_AREAS,
            project,
            mutationProject,
            section,
            projectArea,
            taskArea,
            settings: state.settings,
            focusedCount: derived.focusedCount,
            promoteTaskToProject: state.promoteTaskToProject,
            convertTaskToSection: state.convertTaskToSection,
            resetTaskChecklist: state.resetTaskChecklist,
            restoreTask: state.restoreTask,
            highlightTaskId: state.highlightTaskId,
            setHighlightTask: state.setHighlightTask,
            addProject: state.addProject,
            addArea: state.addArea,
            addPerson: state.addPerson,
            addSection: state.addSection,
            lockEditing: state.lockEditing,
            unlockEditing: state.unlockEditing,
            projectMap: includeQuickActionFocusData ? derived.projectMap : EMPTY_PROJECT_MAP,
            activeTasksByStatus: includeQuickActionFocusData ? derived.activeTasksByStatus : EMPTY_TASKS_BY_STATUS,
            sequentialProjectIds: includeQuickActionFocusData ? derived.sequentialProjectIds : EMPTY_ID_SET,
            sequentialWithinSectionProjectIds: includeQuickActionFocusData
                ? derived.sequentialWithinSectionProjectIds
                : EMPTY_ID_SET,
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
