import { RESTORABLE_VIEWS } from './session-restore';
import { isQuickAddWindowLocation } from './quick-add-window';


export const VIEW_URL_PARAM = 'view';


const URL_KNOWN_VIEWS = new Set([...RESTORABLE_VIEWS, 'settings', 'obsidian']);

const isKnownView = (view: string): boolean =>
    URL_KNOWN_VIEWS.has(view) || view.startsWith('savedSearch:');

export function readViewFromUrl(
    search: string = typeof window === 'undefined' ? '' : window.location.search,
): string | null {
    const view = new URLSearchParams(search).get(VIEW_URL_PARAM);
    if (!view || !isKnownView(view)) return null;
    return view;
}

export function writeViewToUrl(view: string): void {
    if (typeof window === 'undefined') return;


    if (isQuickAddWindowLocation()) return;
    const url = new URL(window.location.href);
    url.searchParams.set(VIEW_URL_PARAM, view);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}
