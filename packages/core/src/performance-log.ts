export const PERFORMANCE_LOG_SCOPE = 'performance' as const;
export const PERFORMANCE_LOG_MESSAGE = 'performance_event' as const;

export type PerformanceOperation =
    | 'unknown'
    | 'task_save_to_list'
    | 'task_done_to_list'
    | 'task_mutation'
    | 'task_persistence'
    | 'task_list_derive'
    | 'task_list_commit'
    | 'project_reorder_enter'
    | 'navigation_transition';

export type PerformanceRoute =
    | 'unknown'
    | 'inbox'
    | 'project'
    | 'focus'
    | 'next'
    | 'review'
    | 'search'
    | 'settings';

export type PerformancePlatform = 'android' | 'ios' | 'desktop';

export type PerformanceLogInput = {
    operation: PerformanceOperation;
    elapsedMs: number;
    route: PerformanceRoute;
    taskCount?: number;
    projectCount?: number;
    areaCount?: number;
    sectionCount?: number;
    listItemCount?: number;
    visibleItemCount?: number;
    filterCount?: number;


    rowRenderCount?: number;


    scrollRetryCount?: number;
    platform?: PerformancePlatform;
    appVersion?: string;
};

export type PerformanceLogMeasurementInput = Omit<PerformanceLogInput, 'elapsedMs'>;
export type PerformanceLogMeasurementFinishInput = Partial<Pick<PerformanceLogInput,
    | 'taskCount'
    | 'projectCount'
    | 'areaCount'
    | 'sectionCount'
    | 'listItemCount'
    | 'visibleItemCount'
    | 'filterCount'
    | 'rowRenderCount'
    | 'scrollRetryCount'
    | 'platform'
    | 'appVersion'
>>;

export type PerformanceLogEntry = {
    ts: string;
    level: 'info';
    scope: typeof PERFORMANCE_LOG_SCOPE;
    message: typeof PERFORMANCE_LOG_MESSAGE;
    context: Record<string, string>;
};

export const PERFORMANCE_LOG_OPERATIONS: readonly PerformanceOperation[] = [
    'unknown',
    'task_save_to_list',
    'task_done_to_list',
    'task_mutation',
    'task_persistence',
    'task_list_derive',
    'task_list_commit',
    'project_reorder_enter',
    'navigation_transition',
];

export const PERFORMANCE_LOG_ROUTES: readonly PerformanceRoute[] = [
    'unknown',
    'inbox',
    'project',
    'focus',
    'next',
    'review',
    'search',
    'settings',
];

export const PERFORMANCE_LOG_PLATFORMS: readonly PerformancePlatform[] = [
    'android',
    'ios',
    'desktop',
];

export const PERFORMANCE_LOG_CONTEXT_KEYS: readonly string[] = [
    'operation',
    'elapsedMs',
    'route',
    'taskCount',
    'projectCount',
    'areaCount',
    'sectionCount',
    'listItemCount',
    'visibleItemCount',
    'filterCount',
    'rowRenderCount',
    'scrollRetryCount',
    'platform',
    'appVersion',
];

export const PERFORMANCE_LOG_FORBIDDEN_CONTEXT_KEYS: readonly string[] = [
    'title',
    'description',
    'notes',
    'taskId',
    'projectId',
    'areaId',
    'sectionId',
    'text',
    'query',
    'url',
    'name',
    'areaName',
    'projectName',
    'sectionName',
    'contextName',
    'tagName',
];

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.-]+)?$/;

export const isPerformanceOperation = (value: unknown): value is PerformanceOperation => (
    typeof value === 'string' && PERFORMANCE_LOG_OPERATIONS.includes(value as PerformanceOperation)
);

export const isPerformanceRoute = (value: unknown): value is PerformanceRoute => (
    typeof value === 'string' && PERFORMANCE_LOG_ROUTES.includes(value as PerformanceRoute)
);

export const isPerformancePlatform = (value: unknown): value is PerformancePlatform => (
    typeof value === 'string' && PERFORMANCE_LOG_PLATFORMS.includes(value as PerformancePlatform)
);

const normalizeOperation = (value: PerformanceOperation): PerformanceOperation => (
    isPerformanceOperation(value) ? value : 'unknown'
);

const normalizeRoute = (value: PerformanceRoute): PerformanceRoute => (
    isPerformanceRoute(value) ? value : 'unknown'
);

const normalizeElapsedMs = (value: number): string => {
    if (!Number.isFinite(value)) return '0';
    return String(Math.max(0, Math.round(value)));
};

const normalizeCount = (value: number | undefined): string | undefined => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    return String(Math.max(0, Math.trunc(value)));
};

const normalizeVersion = (value: string | undefined): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (!VERSION_PATTERN.test(trimmed)) return undefined;
    return trimmed;
};

const addCount = (context: Record<string, string>, key: string, value: number | undefined): void => {
    const normalized = normalizeCount(value);
    if (normalized !== undefined) {
        context[key] = normalized;
    }
};

export function buildPerformanceLogContext(input: PerformanceLogInput): Record<string, string> {
    const context: Record<string, string> = {
        operation: normalizeOperation(input.operation),
        elapsedMs: normalizeElapsedMs(input.elapsedMs),
        route: normalizeRoute(input.route),
    };

    addCount(context, 'taskCount', input.taskCount);
    addCount(context, 'projectCount', input.projectCount);
    addCount(context, 'areaCount', input.areaCount);
    addCount(context, 'sectionCount', input.sectionCount);
    addCount(context, 'listItemCount', input.listItemCount);
    addCount(context, 'visibleItemCount', input.visibleItemCount);
    addCount(context, 'filterCount', input.filterCount);
    addCount(context, 'scrollRetryCount', input.scrollRetryCount);
    addCount(context, 'rowRenderCount', input.rowRenderCount);

    if (isPerformancePlatform(input.platform)) {
        context.platform = input.platform;
    }

    const appVersion = normalizeVersion(input.appVersion);
    if (appVersion !== undefined) {
        context.appVersion = appVersion;
    }

    return context;
}

export function buildPerformanceLogEntry(
    input: PerformanceLogInput,
    options?: { timestamp?: string }
): PerformanceLogEntry {
    return {
        ts: options?.timestamp ?? new Date().toISOString(),
        level: 'info',
        scope: PERFORMANCE_LOG_SCOPE,
        message: PERFORMANCE_LOG_MESSAGE,
        context: buildPerformanceLogContext(input),
    };
}

export function buildPerformanceLogLine(
    input: PerformanceLogInput,
    options?: { timestamp?: string }
): string {
    return `${JSON.stringify(buildPerformanceLogEntry(input, options))}\n`;
}

const defaultNow = (): number => {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
};

const mergeMeasurementInput = (
    input: PerformanceLogMeasurementInput,
    elapsedMs: number,
    finishInput?: PerformanceLogMeasurementFinishInput
): PerformanceLogInput => ({
    operation: input.operation,
    elapsedMs,
    route: input.route,
    taskCount: finishInput?.taskCount ?? input.taskCount,
    projectCount: finishInput?.projectCount ?? input.projectCount,
    areaCount: finishInput?.areaCount ?? input.areaCount,
    sectionCount: finishInput?.sectionCount ?? input.sectionCount,
    listItemCount: finishInput?.listItemCount ?? input.listItemCount,
    rowRenderCount: finishInput?.rowRenderCount ?? input.rowRenderCount,
    visibleItemCount: finishInput?.visibleItemCount ?? input.visibleItemCount,
    filterCount: finishInput?.filterCount ?? input.filterCount,
    scrollRetryCount: finishInput?.scrollRetryCount ?? input.scrollRetryCount,
    platform: finishInput?.platform ?? input.platform,
    appVersion: finishInput?.appVersion ?? input.appVersion,
});

export function beginPerformanceLogMeasurement(
    input: PerformanceLogMeasurementInput,
    options: { diagnosticsEnabled: boolean; now?: () => number }
): { finish: (finishInput?: PerformanceLogMeasurementFinishInput) => Record<string, string> } | null {
    if (!options.diagnosticsEnabled) return null;
    const now = options.now ?? defaultNow;
    const startedAt = now();
    return {
        finish: (finishInput?: PerformanceLogMeasurementFinishInput) => {
            const elapsedMs = Math.max(0, now() - startedAt);
            return buildPerformanceLogContext(mergeMeasurementInput(input, elapsedMs, finishInput));
        },
    };
}
