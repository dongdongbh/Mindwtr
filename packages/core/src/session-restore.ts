


export const SESSION_RESTORE_WINDOW_MS = 25 * 60 * 1000;


const SESSION_RESTORE_CLOCK_SKEW_MS = 60 * 1000;

export function shouldRestoreLastView(savedAtMs: unknown, nowMs: number = Date.now()): boolean {
    if (typeof savedAtMs !== 'number' || !Number.isFinite(savedAtMs)) return false;
    const age = nowMs - savedAtMs;
    return age >= -SESSION_RESTORE_CLOCK_SKEW_MS && age <= SESSION_RESTORE_WINDOW_MS;
}


export const LAST_ROUTE_STORAGE_KEY = 'mindwtr:session:lastRoute';


const RESTORABLE_PATHS = new Set([
    '/focus',
    '/inbox',
    '/projects',
    '/calendar-tab',
    '/contexts-tab',
    '/review-tab',
    '/menu',
    '/projects-screen',
    '/board',
    '/calendar',
    '/contexts',
    '/history',
    '/reference',
    '/someday',
    '/waiting',
    '/review',
    '/trash',
]);

export const isRestorableLastRoutePath = (pathname: string): boolean =>
    RESTORABLE_PATHS.has(pathname) || pathname.startsWith('/saved-search/');


const PROJECT_CONTEXT_PATHS = new Set(['/projects-screen', '/projects']);


const HISTORY_TAB_PATH = '/history';
const HISTORY_TABS = new Set(['done', 'archived']);

export type LastRouteSnapshot = {
    pathname: string;
    params?: Record<string, string>;
};


export function buildLastRouteSnapshot(
    pathname: string,
    params: Record<string, unknown> | undefined,
    openProjectId: string | null,
    nowMs: number,
): string | null {
    if (!isRestorableLastRoutePath(pathname)) return null;


    const explicitProjectId = typeof params?.projectId === 'string' ? params.projectId : undefined;
    const projectId = PROJECT_CONTEXT_PATHS.has(pathname)
        ? explicitProjectId ?? openProjectId ?? undefined
        : undefined;
    const tab = pathname === HISTORY_TAB_PATH && typeof params?.tab === 'string' && HISTORY_TABS.has(params.tab)
        ? params.tab
        : undefined;
    return JSON.stringify({
        pathname,
        ...(projectId ? { params: { projectId } } : {}),
        ...(tab ? { params: { tab } } : {}),
        at: nowMs,
    });
}


export function parseRestorableLastRoute(raw: string | null | undefined, nowMs: number = Date.now()): LastRouteSnapshot | null {
    try {
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { pathname?: unknown; params?: unknown; at?: unknown } | null;
        if (!parsed || typeof parsed.pathname !== 'string' || !isRestorableLastRoutePath(parsed.pathname)) return null;
        if (!shouldRestoreLastView(parsed.at, nowMs)) return null;
        const params = parsed.params && typeof parsed.params === 'object' && !Array.isArray(parsed.params)
            ? Object.fromEntries(
                Object.entries(parsed.params as Record<string, unknown>)
                    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
            )
            : undefined;
        return {
            pathname: parsed.pathname,
            ...(params && Object.keys(params).length > 0 ? { params } : {}),
        };
    } catch {
        return null;
    }
}
