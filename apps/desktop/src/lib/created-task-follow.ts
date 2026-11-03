import { useTaskStore, type Task } from '@mindwtr/core';

import { useUiStore } from '../store/ui-store';
import { dispatchNavigateEvent, type DesktopViewId } from './navigation-events';
import { resolveTaskNavigationView, type TaskNavigationInput } from './task-navigation';


export function resolveViewForTask(task: TaskNavigationInput & Pick<Task, 'projectId'>): DesktopViewId {
    if (task.projectId) return 'projects';
    return resolveTaskNavigationView(task);
}

function navigateToTaskView(task: Task, view: DesktopViewId): void {
    useTaskStore.getState().setHighlightTask(task.id);
    if (view === 'projects' && task.projectId) {
        useUiStore.getState().setProjectView({ selectedProjectId: task.projectId });
    }
    dispatchNavigateEvent(view);
}


export function followCreatedTaskAfterEdit(taskId: string, openedIn: DesktopViewId): () => void {
    const unsubscribe = useUiStore.subscribe((state, previous) => {
        if (previous.editingTaskId !== taskId || state.editingTaskId === taskId) return;
        unsubscribe();
        const task = useTaskStore.getState()._allTasks.find((candidate) => candidate.id === taskId);
        if (!task || task.deletedAt) return;
        const view = resolveViewForTask(task);
        if (view === openedIn) return;
        navigateToTaskView(task, view);
    });
    return unsubscribe;
}
