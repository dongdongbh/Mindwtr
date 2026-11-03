import type { TaskPriority } from './types';
export const DEFAULT_PROJECT_COLOR = '#94a3b8';
export const DEFAULT_AREA_COLOR = DEFAULT_PROJECT_COLOR;
export const isValidProjectColorOverride = (value: unknown): value is string | null | undefined =>
    value == null || typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);


export const AREA_PRESET_COLORS = [
    '#3b82f6',
    '#10b981',
    '#f59e0b',
    '#ef4444',
    '#8b5cf6',
    '#ec4899',
    '#f97316',
    '#14b8a6',
    '#06b6d4',
    '#6366f1',
    '#f43f5e',
    '#64748b',
] as const;


export const TASK_PRIORITY_COLORS: Readonly<Record<TaskPriority, string>> = {
    urgent: '#dc2626',
    high: '#f97316',
    medium: '#ca8a04',
    low: '#3b82f6',
};
