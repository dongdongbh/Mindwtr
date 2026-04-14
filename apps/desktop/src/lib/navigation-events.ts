export type DesktopViewId =
    | 'inbox'
    | 'agenda'
    | 'next'
    | 'someday'
    | 'reference'
    | 'waiting'
    | 'done'
    | 'calendar'
    | 'board'
    | 'obsidian'
    | 'projects'
    | 'contexts'
    | 'review'
    | 'settings'
    | 'archived'
    | 'trash'
    | `savedSearch:${string}`;

export type NavigateEventDetail = {
    view: DesktopViewId;
};

export const MINDWTR_NAVIGATE_EVENT = 'mindwtr:navigate';

export function dispatchNavigateEvent(view: DesktopViewId): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(
        new CustomEvent<NavigateEventDetail>(MINDWTR_NAVIGATE_EVENT, {
            detail: { view },
        })
    );
}

export function subscribeNavigateEvent(
    handler: (detail: NavigateEventDetail) => void,
): () => void {
    if (typeof window === 'undefined') {
        return () => undefined;
    }

    const listener: EventListener = (event) => {
        const detail = (event as CustomEvent<NavigateEventDetail | undefined>).detail;
        if (!detail?.view) return;
        handler(detail);
    };

    window.addEventListener(MINDWTR_NAVIGATE_EVENT, listener);
    return () => window.removeEventListener(MINDWTR_NAVIGATE_EVENT, listener);
}
