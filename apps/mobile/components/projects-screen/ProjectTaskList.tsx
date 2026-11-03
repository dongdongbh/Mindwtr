import React from 'react';
import type { FlatList, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import {
    getProjectDetailTaskListOptions,
    type Project,
    type ProjectSequenceTaskCue,
    type Task,
    type TaskSortBy,
} from '@mindwtr/core';

import { TaskList, type TaskListProjectOptions } from '../task-list';
import type { TaskListBulkBarProps } from '../task-list/TaskListBulkBar';


export { getProjectDetailTaskListOptions };

export interface ProjectTaskListProps {
    project: Project;

    tasks?: Task[];
    showCompletedTasks: boolean;
    sortBy: TaskSortBy;
    getTaskSequenceCue: (task: Task) => ProjectSequenceTaskCue | undefined;
    sequenceCueLabels: Record<ProjectSequenceTaskCue, string>;
    reorderMode: boolean;
    onReorderModeChange: (active: boolean) => void;

    listHeaderComponent: React.ReactElement | null;
    listRef: React.Ref<FlatList>;
    onListScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    contentPaddingBottom: number;

    onBulkBarPropsChange: (props: TaskListBulkBarProps | null) => void;
    filterOpenSignal: number;
    onFilterStateChange: (state: { activeCount: number; hasActive: boolean }) => void;
}


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
            readOnly: options.readOnly,
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
            enableBulkActions={!projectOptions.readOnly}
            bulkBarPlacement="external"
            onBulkBarPropsChange={onBulkBarPropsChange}
            contentPaddingBottom={contentPaddingBottom}
            externalFilterOpenSignal={filterOpenSignal}
            listHeaderComponent={listHeaderComponent}
            listRef={listRef}
            onFilterStateChange={onFilterStateChange}
            onListScroll={onListScroll}

            showHeader={false}
            showFilterButton={false}
            showSort={false}
            showTimeEstimateFilters={false}
        />
    );
}
