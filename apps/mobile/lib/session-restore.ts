import { workspaceSessionStorage as AsyncStorage } from '@/lib/workspace-session-storage';
import { shouldRestoreLastView } from '@mindwtr/core';

// Device-local UI-session state (P14): which screen was open and when it was
// last seen, so reopening shortly after Android kills the app resumes the
// interrupted session (#842). Never part of the synced settings document.
const LAST_ROUTE_STORAGE_KEY = 'mindwtr:session:lastRoute';

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
    '/done',
    '/archived',
    '/reference',
    '/someday',
    '/waiting',
    '/review',
    '/trash',
]);

const isRestorablePath = (pathname: string): boolean =>
    RESTORABLE_PATHS.has(pathname) || pathname.startsWith('/saved-search/');

// Routes whose snapshot may carry an open-project context.
const PROJECT_CONTEXT_PATHS = new Set(['/projects-screen', '/projects']);

// Tapping a project row opens it via component state without touching the
// route, so the route params alone can't tell which project is open — the
// projects screen mirrors it here for snapshots (#842).
let sessionOpenProjectId: string | null = null;

export function setSessionRestoreOpenProject(projectId: string | null): void {
    sessionOpenProjectId = projectId;
}

export type LastRouteSnapshot = {
    pathname: string;
    params?: Record<string, string>;
};

export async function persistLastRoute(pathname: string, params?: Record<string, unknown>): Promise<void> {
    try {
        // Transient surfaces (capture modals, settings, review flows) keep the
        // previous snapshot: dying inside one should still resume the screen
        // beneath it, and a stale timestamp ages the snapshot out naturally.
        if (!isRestorablePath(pathname)) return;
        // Only the project context is worth carrying across a restart; other
        // params (open tokens, one-shot focus requests) must not replay.
        const explicitProjectId = typeof params?.projectId === 'string' ? params.projectId : undefined;
        const projectId = PROJECT_CONTEXT_PATHS.has(pathname)
            ? explicitProjectId ?? sessionOpenProjectId ?? undefined
            : undefined;
        await AsyncStorage.setItem(LAST_ROUTE_STORAGE_KEY, JSON.stringify({
            pathname,
            ...(projectId ? { params: { projectId } } : {}),
            at: Date.now(),
        }));
    } catch {
        // Convenience state only — a storage failure just skips restoration.
    }
}

export async function readRestorableRoute(nowMs: number = Date.now()): Promise<LastRouteSnapshot | null> {
    try {
        const raw = await AsyncStorage.getItem(LAST_ROUTE_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { pathname?: unknown; params?: unknown; at?: unknown } | null;
        if (!parsed || typeof parsed.pathname !== 'string' || !isRestorablePath(parsed.pathname)) return null;
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
