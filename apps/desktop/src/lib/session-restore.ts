import { shouldRestoreLastView } from '@mindwtr/core';

// Device-local UI-session state (P14): which screen was open and when it was
// last seen. Never part of the synced settings document.
const LAST_VIEW_STORAGE_KEY = 'mindwtr-last-view';

// Settings is a transient destination and Obsidian depends on device config;
// both fall back to the default view instead of restoring. Exported so
// view-url-params.ts can build its own, larger allow-list on top of it —
// the URL is a separate, explicit signal that settings/obsidian may use.
export const RESTORABLE_VIEWS = new Set([
    'inbox',
    'agenda',
    'next',
    'someday',
    'reference',
    'waiting',
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
        // Transient destinations keep the previous snapshot: dying inside
        // Settings within the window should still resume the screen before it,
        // and a stale timestamp ages the snapshot out naturally.
        if (!isRestorableView(view)) return;
        window.localStorage.setItem(LAST_VIEW_STORAGE_KEY, JSON.stringify({
            view,
            ...(view === 'projects' && projectId ? { projectId } : {}),
            at: Date.now(),
        }));
    } catch {
        // Convenience state only — a storage failure just skips restoration.
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
