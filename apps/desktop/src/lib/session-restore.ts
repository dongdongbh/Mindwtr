import { shouldRestoreLastView } from '@mindwtr/core';


const LAST_VIEW_STORAGE_KEY = 'mindwtr-last-view';


export const RESTORABLE_VIEWS = new Set([
    'inbox',
    'agenda',
    'next',
    'someday',
    'reference',
    'waiting',
    'history',
    'done',
    'calendar',
    'board',
    'timeline',
    'projects',
    'contexts',
    'review',
    'archived',
    'trash',
]);

export type LastViewSnapshot = {
    view: string;
    projectId?: string;
};

const isRestorableView = (view: string): boolean =>
    RESTORABLE_VIEWS.has(view) || view.startsWith('savedSearch:');

export function persistLastView(view: string, projectId?: string | null): void {
    try {


        if (!isRestorableView(view)) return;
        window.localStorage.setItem(LAST_VIEW_STORAGE_KEY, JSON.stringify({
            view,
            ...(view === 'projects' && projectId ? { projectId } : {}),
            at: Date.now(),
        }));
    } catch {

    }
}

export function readRestorableLastView(nowMs: number = Date.now()): LastViewSnapshot | null {
    try {
        const raw = window.localStorage.getItem(LAST_VIEW_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { view?: unknown; projectId?: unknown; at?: unknown } | null;
        if (!parsed || typeof parsed.view !== 'string' || !isRestorableView(parsed.view)) return null;
        if (!shouldRestoreLastView(parsed.at, nowMs)) return null;
        return {
            view: parsed.view,
            ...(typeof parsed.projectId === 'string' && parsed.projectId ? { projectId: parsed.projectId } : {}),
        };
    } catch {
        return null;
    }
}
