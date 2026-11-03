


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


export function sanitizeHiddenSidebarViews(value: unknown): HideableSidebarViewId[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((id): id is HideableSidebarViewId => typeof id === 'string' && HIDEABLE_ID_SET.has(id)))];
}
