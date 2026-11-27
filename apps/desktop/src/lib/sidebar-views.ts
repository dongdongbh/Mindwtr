


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

export function isSidebarViewHidden(view: string, hidden: readonly string[]): boolean {
    return view === 'history'
        ? hidden.includes('done') && hidden.includes('archived')
        : hidden.includes(view);
}

export function resolveDesktopStartupView(explicit: string | null, restored: string | undefined, hidden: readonly string[]): string {
    const candidate = restored ?? 'agenda';
    return explicit ?? (isSidebarViewHidden(candidate, hidden) ? 'inbox' : candidate);
}
