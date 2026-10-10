import { isSandboxMode, useTaskStore } from '@mindwtr/core';
import { useUiStore } from '../store/ui-store';
import { isLoggingEnabled, logInfo } from './app-log';

const views = new Set([
    'inbox', 'agenda', 'next', 'waiting', 'someday', 'reference', 'history', 'done',
    'archived', 'calendar', 'board', 'timeline', 'obsidian', 'projects', 'contexts',
    'review', 'settings', 'trash',
]);
const safeView = (view: string) => view.startsWith('savedSearch:') ? 'saved-search' : views.has(view) ? view : 'other';
const rendererRun = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
let navigationSequence = 0;
let committedView = 'unknown';

export type RendererNavigationTrace = {
    sequence: number;
    previousView: string;
    nextView: string;
    startedAt: number;
    enabled: boolean;
    committed?: boolean;
    frameLogged?: boolean;
};

const bucket = (count: number) => count === 0 ? '0' : count <= 10 ? '1-10' : count <= 100 ? '11-100' : count <= 1000 ? '101-1000' : '1001+';

function snapshot() {
    const state = useTaskStore.getState();
    let trash = 0;
    let history = 0;
    let reference = 0;
    let board = 0;
    for (const task of state._allTasks) {
        if (task.deletedAt) trash++;
        else {
            if (task.status === 'done' || task.status === 'archived') history++;
            if (task.status === 'reference') reference++;
            if (task.status !== 'reference' && task.status !== 'archived') board++;
        }
    }
    const density = state.settings.appearance?.density;
    return {
        workspace: isSandboxMode() ? 'sandbox' : 'personal',
        taskCountBucket: bucket(state._allTasks.length),
        projectCountBucket: bucket(state._allProjects.length),
        trashCountBucket: bucket(trash),
        historyCountBucket: bucket(history),
        referenceCountBucket: bucket(reference),
        boardCountBucket: bucket(board),
        density: density === 'compact' || density === 'condensed' ? density : 'comfortable',
        showDetails: useUiStore.getState().listOptions.showDetails === true,
        editorOpen: useUiStore.getState().editingTaskId !== null,
        documentVisibility: document.visibilityState === 'hidden' ? 'hidden' : 'visible',
    };
}

function write(trace: RendererNavigationTrace, stage: string, actualView?: string, state?: ReturnType<typeof snapshot>) {
    if (!trace.enabled || !isLoggingEnabled()) return;
    void logInfo('Renderer navigation phase', {
        scope: 'renderer-navigation',
        extra: {
            releaseCheck: 'v1.3.5/renderer-navigation', rendererRun,
            navigationSequence: trace.sequence, stage,
            previousView: trace.previousView, nextView: trace.nextView,
            ...(actualView ? { actualView } : {}),
            elapsedMs: Math.round(performance.now() - trace.startedAt),
            ...(state ?? snapshot()),
        },
    });
}

/** Called before the transition; logging never delays navigation or awaits disk. */
export function beginRendererNavigation(view: string): RendererNavigationTrace {
    const trace = {
        sequence: ++navigationSequence, previousView: committedView, nextView: safeView(view),
        startedAt: performance.now(), enabled: isLoggingEnabled(),
    };
    write(trace, 'requested');
    return trace;
}

/** Only called by content committed inside Suspense, never by its fallback. */
export function commitRendererNavigation(view: string, trace: RendererNavigationTrace | null): () => void {
    committedView = safeView(view) === 'other' ? 'inbox' : safeView(view);
    if (!trace?.enabled || !isLoggingEnabled()) return () => {};
    const actualView = committedView;
    const state = snapshot();
    if (!trace.committed) {
        trace.committed = true;
        write(trace, 'content-committed', actualView, state);
    }
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
        if (cancelled || trace.sequence !== navigationSequence || trace.frameLogged) return;
        trace.frameLogged = true;
        // A callback is evidence of renderer progress, not proof of a successful paint.
        write(trace, 'animation-frame', actualView, state);
    });
    return () => { cancelled = true; cancelAnimationFrame(frame); };
}
