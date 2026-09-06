import type { TaskPriority } from '@mindwtr/core';

// Priority "heat ramp": a fixed set, not theme tokens, so a priority reads the
// same in every theme, on the task row strip and on the widget dot. Callers
// null the priority when the Priorities feature is off.
export const PRIORITY_STRIP_COLORS: Record<TaskPriority, string> = {
    urgent: '#dc2626',
    high: '#f97316',
    medium: '#ca8a04',
    low: '#3b82f6',
};
