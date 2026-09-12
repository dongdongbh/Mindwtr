import { workspaceSessionStorage as AsyncStorage } from '@/lib/workspace-session-storage';
import { shouldRestoreLastView } from '@mindwtr/core';
import type { NavigationState } from '@react-navigation/native';

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

const TRANSIENT_ACTIVITY_ROOT_ROUTES = new Set(['capture-modal']);
const SAFE_ACTIVITY_ROUTE_PARAMS = new Set(['id', 'projectId', 'settingsScreen']);
const MAX_ACTIVITY_NAVIGATION_DEPTH = 12;
const MAX_ACTIVITY_ROUTES_PER_STATE = 64;

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

const sanitizeActivityRouteParams = (params: unknown): Record<string, string | number | boolean> | undefined => {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
    const safe = Object.entries(params as Record<string, unknown>).filter(
        (entry): entry is [string, string | number | boolean] => (
            SAFE_ACTIVITY_ROUTE_PARAMS.has(entry[0])
            && (typeof entry[1] === 'string' || typeof entry[1] === 'number' || typeof entry[1] === 'boolean')
        ),
    );
    return safe.length > 0 ? Object.fromEntries(safe) : undefined;
};

const sanitizeActivityNavigationStateNode = (
    value: unknown,
    depth: number,
    root: boolean,
): NavigationState | null => {
    if (!value || typeof value !== 'object' || depth > MAX_ACTIVITY_NAVIGATION_DEPTH) return null;
    const state = value as NavigationState & Record<string, unknown>;
    if (!Array.isArray(state.routes)
        || state.routes.length === 0
        || state.routes.length > MAX_ACTIVITY_ROUTES_PER_STATE) return null;

    const originalActiveRoute = state.routes[Math.min(Math.max(state.index ?? 0, 0), state.routes.length - 1)];
    let routes = state.routes.flatMap((route) => {
        if (!route || typeof route.name !== 'string' || typeof route.key !== 'string') return [];
        if (root && TRANSIENT_ACTIVITY_ROOT_ROUTES.has(route.name)) return [];
        const nestedState = route.state
            ? sanitizeActivityNavigationStateNode(route.state, depth + 1, false)
            : null;
        const params = sanitizeActivityRouteParams(route.params);
        return [{
            ...route,
            path: undefined,
            params,
            state: nestedState ?? undefined,
        }];
    });
    // Index is a startup redirect, not useful back history. Keeping it mounted
    // beside a recovered route lets its async Redirect race resetRoot.
    if (root && routes.length > 1) {
        routes = routes.filter((route) => route.name !== 'index');
    }
    if (routes.length === 0) return null;

    const activeIndex = originalActiveRoute
        ? routes.findIndex((route) => route.key === originalActiveRoute.key)
        : -1;
    const index = activeIndex >= 0 ? activeIndex : routes.length - 1;
    const routeKeys = new Set(routes.map((route) => route.key));
    const history = Array.isArray(state.history)
        ? state.history.filter((entry) => {
            if (!entry || typeof entry !== 'object') return false;
            const routeKey = (entry as { key?: unknown }).key;
            return typeof routeKey !== 'string' || routeKeys.has(routeKey);
        })
        : undefined;

    return {
        ...state,
        index,
        routes,
        routeNames: Array.isArray(state.routeNames)
            ? state.routeNames.filter((name) => !(root && TRANSIENT_ACTIVITY_ROOT_ROUTES.has(name)))
            : routes.map((route) => route.name),
        ...(history ? { history } : {}),
        preloadedRoutes: undefined,
    } as NavigationState;
};

/**
 * Removes routed capture and one-shot action payloads before a same-process
 * Activity snapshot can be replayed through React Navigation resetRoot.
 */
export function sanitizeAndroidActivityNavigationState(state: NavigationState | undefined): NavigationState | null {
    return sanitizeActivityNavigationStateNode(state, 0, true);
}

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
