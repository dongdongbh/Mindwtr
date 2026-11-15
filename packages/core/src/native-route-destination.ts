import { normalizeShortcutTags, parseShortcutCaptureUrl } from './capture-deeplink';
import type { NativeEntryPoint } from './native-host-contract-entry-points';
import { isSelectableProjectForTaskAssignment } from './project-utils';
import { normalizeSavedFilters } from './saved-filters';
import type { Project, Task } from './types';
import { normalizeWidgetListDestinationId } from './widget-list-destination';

export type NativeRouteDestination =
    | { type: 'none' | 'focus' | 'inbox' | 'waiting' | 'someday' | 'projects' | 'review' | 'calendar' | 'capture'
        | 'shortcutCapture' | 'contextAutomation' }
    | { type: 'contexts' | 'focusFilter'; savedFilterId: string }
    | { type: 'widgetList'; listId: string }
    | { type: 'notice'; title: string; message: string };

export type NativeShortcutCaptureDraft =
    | { type: 'none' }
    | { type: 'draft'; captureId: string; text: string; note: string; projectId: string; tags: string[] };

const SURFACE_ROUTES = new Map<string, NativeRouteDestination>([
    ['/focus', { type: 'focus' }],
    ['/inbox', { type: 'inbox' }],
    ['/waiting', { type: 'waiting' }],
    ['/someday', { type: 'someday' }],
    ['/projects', { type: 'projects' }],
    ['/review-tab', { type: 'review' }],
    ['/calendar', { type: 'calendar' }],
]);
const WIDGET_LIST_ROUTE = '/widget-list/';
const SAVED_FILTER_LIST_PREFIX = 'filter:';
const PROJECT_LIST_PREFIX = 'project:';
const SAVED_FILTER_ID_LIMIT = 500;
const NONE: NativeRouteDestination = { type: 'none' };
const CAPTURE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CAPTURE_TAG_LIMIT = 50;
const CAPTURE_TAG_LENGTH = 200;

const isShortcutCapture = (target: NativeEntryPoint) => target.captureModal !== null
    && typeof target.captureModal.params.initialValue === 'string' && target.captureModal.params.origin === undefined;

const isSystemQuickCapture = (target: NativeEntryPoint) => target.route === null
    && target.captureModal !== null && Object.keys(target.captureModal.params).join() === 'origin'
    && target.captureModal.params.origin === 'system';

function widgetListDestination(route: string, savedFilters: unknown): NativeRouteDestination {
    let decoded: string;
    try {
        decoded = decodeURIComponent(route.slice(WIDGET_LIST_ROUTE.length));
    } catch {
        return NONE;
    }
    const listId = normalizeWidgetListDestinationId(decoded);
    if (!listId || listId.startsWith(PROJECT_LIST_PREFIX)) return NONE;
    if (!listId.startsWith(SAVED_FILTER_LIST_PREFIX)) return { type: 'widgetList', listId };
    const savedFilterId = listId.slice(SAVED_FILTER_LIST_PREFIX.length);
    if (savedFilterId.length > SAVED_FILTER_ID_LIMIT) return NONE;
    const filter = normalizeSavedFilters(savedFilters)
        .find((candidate) => candidate.id === savedFilterId && !candidate.deletedAt);
    if (!filter) return { type: 'widgetList', listId };
    if (filter.view === 'contexts') return { type: 'contexts', savedFilterId };
    if (filter.view === 'focus' && savedFilterId.length <= 200) return { type: 'focusFilter', savedFilterId };
    return { type: 'widgetList', listId };
}

export function resolveNativeRouteDestination(target: NativeEntryPoint, savedFilters: unknown): NativeRouteDestination {
    if (target.contextAutomation) return { type: 'contextAutomation' };
    if (target.notice && target.route === '/inbox' && !target.taskId && !target.projectId && !target.captureModal) {
        return { type: 'notice', title: 'title' in target.notice ? target.notice.title : '', message: target.notice.message };
    }
    if (target.taskId || target.projectId || target.search || target.notice) return NONE;
    if (target.captureModal) {
        if (isShortcutCapture(target)) return { type: 'shortcutCapture' };
        return isSystemQuickCapture(target) ? { type: 'capture' } : NONE;
    }
    if (target.capture) return { type: 'capture' };
    if (!target.route) return NONE;
    const surface = SURFACE_ROUTES.get(target.route);
    if (surface) return surface;
    return target.route.startsWith(WIDGET_LIST_ROUTE) ? widgetListDestination(target.route, savedFilters) : NONE;
}

const projectToken = (title: string) => (/\s/.test(title) ? `+"${title}"` : `+${title}`);

export function resolveNativeShortcutCaptureDraft(
    url: string,
    data: { tasks: readonly Pick<Task, 'id'>[]; projects: readonly Project[] },
): NativeShortcutCaptureDraft {
    const payload = parseShortcutCaptureUrl(url);
    if (!payload) return { type: 'none' };
    const requestId = (new URL(url).searchParams.get('requestId') ?? '').trim().toLowerCase();
    const captureId = CAPTURE_ID_PATTERN.test(requestId) ? requestId : '';
    if (captureId && data.tasks.some((task) => task.id === captureId)) return { type: 'none' };
    const reference = payload.project?.toLowerCase();
    const match = payload.project
        ? data.projects.find((project) => project.id === payload.project || project.title.toLowerCase() === reference)
        : undefined;
    const text = [payload.title, payload.project && !match ? projectToken(payload.project) : ''].filter(Boolean).join(' ');
    return {
        type: 'draft',
        captureId,
        text,
        note: payload.note ?? '',
        projectId: match && isSelectableProjectForTaskAssignment(match) ? match.id : '',
        tags: normalizeShortcutTags(payload.tags).filter((tag) => tag.length <= CAPTURE_TAG_LENGTH).slice(0, CAPTURE_TAG_LIMIT),
    };
}
