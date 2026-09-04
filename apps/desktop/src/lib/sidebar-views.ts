// Sidebar entries the user can hide from Settings -> General (#1115). This is
// a device-local presentation choice: hiding an entry never disables the view
// itself, which stays reachable through its go-to keybinding and through task
// status. Global search returns tasks and projects, never views, so it is not
// a route back to a hidden entry.
// Inbox and Projects are deliberately absent — they are the structural core of
// the workflow and always render. Obsidian is absent because its own
// integration toggle already controls its sidebar presence, and Timeline is
// only offered while the timeline feature flag is on.
export const HIDEABLE_SIDEBAR_VIEW_IDS = [
    'agenda',
    'someday',
    'waiting',
    'reference',
    'calendar',
    'review',
    'contexts',
    'board',
    'timeline',
    'done',
    'archived',
    'trash',
] as const;

export type HideableSidebarViewId = (typeof HIDEABLE_SIDEBAR_VIEW_IDS)[number];

export const HIDDEN_SIDEBAR_VIEWS_STORAGE_KEY = 'mindwtr:sidebar:hiddenViews:v1';

const HIDEABLE_ID_SET: ReadonlySet<string> = new Set(HIDEABLE_SIDEBAR_VIEW_IDS);

// Drops ids outside the roster so a stale or hand-edited blob can never hide a
// structural entry like Inbox.
export function sanitizeHiddenSidebarViews(value: unknown): HideableSidebarViewId[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((id): id is HideableSidebarViewId => typeof id === 'string' && HIDEABLE_ID_SET.has(id)))];
}
