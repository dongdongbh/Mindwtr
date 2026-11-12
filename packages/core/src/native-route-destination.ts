import type { NativeEntryPoint } from './native-host-contract-entry-points';
import { normalizeSavedFilters } from './saved-filters';
import { normalizeWidgetListDestinationId } from './widget-list-destination';

export type NativeRouteDestination =
    | { type: 'none' | 'focus' | 'inbox' | 'waiting' | 'someday' | 'capture' | 'contextAutomation' }
    | { type: 'contexts'; savedFilterId: string };

const SURFACE_ROUTES = new Map<string, NativeRouteDestination>([
    ['/focus', { type: 'focus' }],
    ['/inbox', { type: 'inbox' }],
    ['/waiting', { type: 'waiting' }],
    ['/someday', { type: 'someday' }],
]);
const WIDGET_LIST_ROUTE = '/widget-list/';
const FOCUS_SECTION_LISTS = new Set(['next', 'upcoming']);
const SAVED_FILTER_LIST_PREFIX = 'filter:';
const SAVED_FILTER_ID_LIMIT = 500;
const NONE: NativeRouteDestination = { type: 'none' };

const isSystemQuickCapture = (target: NativeEntryPoint) => target.route === null
    && target.captureModal !== null && Object.keys(target.captureModal.params).join() === 'origin'
    && target.captureModal.params.origin === 'system';

function widgetListDestination(route: string, savedFilters: unknown): NativeRouteDestination {
    let listId: string;
    try {
        listId = decodeURIComponent(route.slice(WIDGET_LIST_ROUTE.length));
    } catch {
        return NONE;
    }
    if (FOCUS_SECTION_LISTS.has(listId)) return { type: 'focus' };
    const destination = normalizeWidgetListDestinationId(listId);
    if (!destination?.startsWith(SAVED_FILTER_LIST_PREFIX)) return NONE;
    const savedFilterId = destination.slice(SAVED_FILTER_LIST_PREFIX.length);
    if (savedFilterId.length > SAVED_FILTER_ID_LIMIT) return NONE;
    const filter = normalizeSavedFilters(savedFilters)
        .find((candidate) => candidate.id === savedFilterId && candidate.view === 'contexts' && !candidate.deletedAt);
    return filter ? { type: 'contexts', savedFilterId } : NONE;
}

export function resolveNativeRouteDestination(target: NativeEntryPoint, savedFilters: unknown): NativeRouteDestination {
    if (target.contextAutomation) return { type: 'contextAutomation' };
    if (target.taskId || target.projectId || target.search || target.notice) return NONE;
    if (target.captureModal) return isSystemQuickCapture(target) ? { type: 'capture' } : NONE;
    if (target.capture) return { type: 'capture' };
    if (!target.route) return NONE;
    const surface = SURFACE_ROUTES.get(target.route);
    if (surface) return surface;
    return target.route.startsWith(WIDGET_LIST_ROUTE) ? widgetListDestination(target.route, savedFilters) : NONE;
}
