import React from 'react';
import type { FlatList, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import type { Project, ProjectSequenceTaskCue, Task, TaskSortBy } from '@mindwtr/core';

import { TaskList, type TaskListProjectOptions } from '../task-list';
import type { TaskListBulkBarProps } from '../task-list/TaskListBulkBar';

/**
 * What a project's own state makes of its task list. Archived projects are read
 * only and show their finished work inline; live ones hide it behind the
 * Completed pile unless the workspace asks for it.
 */
export function getProjectDetailTaskListOptions(selectedProject: Project | null, showCompletedTasks = false) {
    const isArchived = selectedProject?.status === 'archived';
    return {
        allowAdd: !isArchived,
        enableProjectReorder: !isArchived,
        includeArchived: isArchived || showCompletedTasks,
        includeDone: isArchived || showCompletedTasks,
        groupCompletedTasksLast: !isArchived && showCompletedTasks && !selectedProject?.isSequential,
    };
}

export interface ProjectTaskListProps {
    project: Project;
    /** The project's own tasks; without them the list falls back to the store's pool. */
    tasks?: Task[];
    showCompletedTasks: boolean;
    sortBy: TaskSortBy;
    getTaskSequenceCue: (task: Task) => ProjectSequenceTaskCue | undefined;
    sequenceCueLabels: Record<ProjectSequenceTaskCue, string>;
    reorderMode: boolean;
    onReorderModeChange: (active: boolean) => void;
    /** Details and notes, scrolling away with the rows inside the virtualized list. */
    listHeaderComponent: React.ReactElement | null;
    listRef: React.Ref<FlatList>;
    onListScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    contentPaddingBottom: number;
    /** The workspace draws the bulk bar itself, pinned above its own toolbar. */
    onBulkBarPropsChange: (props: TaskListBulkBarProps | null) => void;
    filterOpenSignal: number;
    onFilterStateChange: (state: { activeCount: number; hasActive: boolean }) => void;
}

/**
 * The task list as the project workspace uses it: sections, sequence cues, task
 * order, the Completed and Reference piles, and chrome the workspace draws
 * itself. Everything project-specific is configured here so the three status
 * screens never see it.
 */
export function ProjectTaskList({
    contentPaddingBottom,
    filterOpenSignal,
    getTaskSequenceCue,
    listHeaderComponent,
    listRef,
    onBulkBarPropsChange,
    onFilterStateChange,
    onListScroll,
    onReorderModeChange,
    project,
    reorderMode,
    sequenceCueLabels,
    showCompletedTasks,
    sortBy,
    tasks,
}: ProjectTaskListProps) {
    // TaskList is React.memo'd on the hottest render path, so this is the one
    // place the grouped prop gets its identity — see the note on TaskListProps.
    const projectOptions = React.useMemo<TaskListProjectOptions>(() => {
        const options = getProjectDetailTaskListOptions(project, showCompletedTasks);
        return {
            id: project.id,
            sortBy,
            includeArchived: options.includeArchived,
            includeDone: options.includeDone,
            groupCompletedTasksLast: options.groupCompletedTasksLast,
            getTaskSequenceCue,
            sequenceCueLabels,
            enableBulkOrganize: options.allowAdd,
            enableReorder: options.enableProjectReorder,
            reorderMode,
            onReorderModeChange,
        };
    }, [
        getTaskSequenceCue,
        onReorderModeChange,
        project,
        reorderMode,
        sequenceCueLabels,
        showCompletedTasks,
        sortBy,
    ]);
    const projectTaskSource = React.useMemo(() => {
        if (!tasks || projectOptions.includeArchived) return tasks;
        return tasks.some((task) => task.status === 'archived')
            ? tasks.filter((task) => task.status !== 'archived')
            : tasks;
    }, [projectOptions.includeArchived, tasks]);

    return (
        <TaskList
            statusFilter="all"
            title={project.title}
            taskSource={projectTaskSource}
            project={projectOptions}
            enableBulkActions
            bulkBarPlacement="external"
            onBulkBarPropsChange={onBulkBarPropsChange}
            contentPaddingBottom={contentPaddingBottom}
            externalFilterOpenSignal={filterOpenSignal}
            listHeaderComponent={listHeaderComponent}
            listRef={listRef}
            onFilterStateChange={onFilterStateChange}
            onListScroll={onListScroll}
            // Header, sort and filter controls all live in the workspace toolbar.
            showHeader={false}
            showFilterButton={false}
            showSort={false}
            showTimeEstimateFilters={false}
        />
    );
}
