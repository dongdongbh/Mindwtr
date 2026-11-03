import type { Task } from './types';

export type TaskMetadataFilterVisibility = {
    energyLevel: boolean;
    location: boolean;
    priority: boolean;
    timeEstimate: boolean;
};


export type TaskMetadataFilterVisibilityOptions = {
    prioritiesEnabled: boolean;
    timeEstimatesEnabled: boolean;
};

const hasText = (value: unknown): boolean => (
    typeof value === 'string' && value.trim().length > 0
);

export function getTaskMetadataFilterVisibility(
    tasks: readonly Pick<Task, 'energyLevel' | 'location' | 'priority' | 'timeEstimate'>[],
    { prioritiesEnabled, timeEstimatesEnabled }: TaskMetadataFilterVisibilityOptions,
): TaskMetadataFilterVisibility {
    return {
        energyLevel: tasks.some((task) => Boolean(task.energyLevel)),
        location: tasks.some((task) => hasText(task.location)),
        priority: prioritiesEnabled && tasks.some((task) => Boolean(task.priority)),
        timeEstimate: timeEstimatesEnabled && tasks.some((task) => Boolean(task.timeEstimate)),
    };
}
