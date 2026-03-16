import type { Task, TimeEstimate } from '@mindwtr/core';

export const MOBILE_TIME_ESTIMATE_OPTIONS: TimeEstimate[] = [
    '5min',
    '10min',
    '15min',
    '30min',
    '1hr',
    '2hr',
    '3hr',
    '4hr',
    '4hr+',
];

export const formatTimeEstimateChipLabel = (value: TimeEstimate): string => {
    if (value === '5min') return '5m';
    if (value === '10min') return '10m';
    if (value === '15min') return '15m';
    if (value === '30min') return '30m';
    if (value === '1hr') return '1h';
    if (value === '2hr') return '2h';
    if (value === '3hr') return '3h';
    if (value === '4hr') return '4h';
    return '4h+';
};

export const matchesSelectedTimeEstimates = (
    task: Pick<Task, 'timeEstimate'>,
    selectedTimeEstimates: TimeEstimate[]
): boolean => {
    if (selectedTimeEstimates.length === 0) return true;
    return Boolean(task.timeEstimate && selectedTimeEstimates.includes(task.timeEstimate as TimeEstimate));
};
