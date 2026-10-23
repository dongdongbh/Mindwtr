/**
 * Reopening the app within this window restores the last viewed screen —
 * interruption recovery (OS killed the app, quick app switch, update restart).
 * After a longer gap the app starts fresh on its home view, keeping the
 * deliberate "orient on today's focus" behavior for new sessions (#842).
 * 25 minutes matches a standard Pomodoro focus block: within one block the
 * user is hypothetically still working, app open or not (reporter-suggested).
 */
export const SESSION_RESTORE_WINDOW_MS = 25 * 60 * 1000;

// Small negative ages tolerate minor clock adjustments between save and read.
const SESSION_RESTORE_CLOCK_SKEW_MS = 60 * 1000;

export function shouldRestoreLastView(savedAtMs: unknown, nowMs: number = Date.now()): boolean {
    if (typeof savedAtMs !== 'number' || !Number.isFinite(savedAtMs)) return false;
    const age = nowMs - savedAtMs;
    return age >= -SESSION_RESTORE_CLOCK_SKEW_MS && age <= SESSION_RESTORE_WINDOW_MS;
}

// The last screen a mobile app showed (moved from React Native's lib/session-restore.ts so the native apps resume the same
// way). Device-local UI-session state (P14), stored by each app in its key-value store under this key; never synced.
export const LAST_ROUTE_STORAGE_KEY = 'mindwtr:session:lastRoute';

// Capture surfaces, review flows, and settings are transient destinations;
// they fall back to the home route instead of restoring.
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

// Routes whose snapshot may carry an open-project context.
const PROJECT_CONTEXT_PATHS = new Set(['/projects-screen', '/projects']);

// History is one screen with two tabs (Done and Archived); restoring it on the
// wrong tab is as wrong as restoring the wrong screen. Only these two values
// are ever replayed.
const HISTORY_TAB_PATH = '/history';
const HISTORY_TABS = new Set(['done', 'archived']);

export type LastRouteSnapshot = {
    pathname: string;
    params?: Record<string, string>;
};

/**
 * The text to store for [pathname], or null to keep the previous snapshot: a transient surface (capture, settings, review
 * flows) is never stored, so dying inside one still resumes the screen beneath it, and a stale time ages it out. Only the
 * project context (the route's projectId, else [openProjectId], the screen's own open project) and History's tab carry over.
 */
export function buildLastRouteSnapshot(
    pathname: string,
    params: Record<string, unknown> | undefined,
    openProjectId: string | null,
    nowMs: number,
): string | null {
    if (!isRestorableLastRoutePath(pathname)) return null;
    // Only the project context is worth carrying across a restart; other
    // params (open tokens, one-shot focus requests) must not replay.
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

/** The stored snapshot [raw] as a route to reopen, or null when it is missing, malformed, transient or older than the window. */
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
