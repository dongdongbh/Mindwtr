export const DEFAULT_FOCUS_TASK_LIMIT = 3;
export const MIN_FOCUS_TASK_LIMIT = 1;
export const MAX_FOCUS_TASK_LIMIT = 10;
export const FOCUS_TASK_LIMIT_OPTIONS = [1, 3, 5, 10] as const;

export const normalizeFocusTaskLimit = (value: unknown): number => {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return DEFAULT_FOCUS_TASK_LIMIT;
    return Math.min(MAX_FOCUS_TASK_LIMIT, Math.max(MIN_FOCUS_TASK_LIMIT, Math.floor(numeric)));
};

export const formatFocusTaskLimitText = (template: string, limit: number): string => {
    const normalizedLimit = normalizeFocusTaskLimit(limit);
    if (template.includes('{{count}}')) {
        return template.split('{{count}}').join(String(normalizedLimit));
    }
    return template.replace(/\b3\b/g, String(normalizedLimit));
};
