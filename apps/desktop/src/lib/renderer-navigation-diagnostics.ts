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
let activitySequence = 0;

type RendererActivity = 'board-sequential' | 'timeline-measurement' | 'timeline-centering';
type RendererActivityStage = 'scheduled' | 'fired' | 'committed' | 'attached' | 'initial-start' | 'initial-end' | 'callback-start' | 'callback-end' | 'centering-start' | 'centering-end' | 'cleanup';
type RendererActivityDetails = {
    attachMode?: 'observer' | 'window-resize';
    outcome?: 'cancelled' | 'already-fired';
    callbackCount?: number;
    widthChangeCount?: number;
    width?: number;
    measured?: boolean;
    todayVisible?: boolean;
    zoom?: 'day' | 'week' | 'month';
    filteredCount?: number;
    visibleCount?: number;
    sequentialProjectCount?: number;
    sequentialResultCount?: number;
};


export function beginRendererActivity(activity: RendererActivity) {
    if (!isLoggingEnabled()) return null;
    return { activity, sequence: ++activitySequence, navigationSequence, startedAt: performance.now(), entries: 0, closed: false };
}

export function recordRendererActivity(trace: ReturnType<typeof beginRendererActivity>, stage: RendererActivityStage, details: RendererActivityDetails = {}) {
    if (!trace || trace.closed) return;
    if (stage === 'cleanup') trace.closed = true;
    if (!isLoggingEnabled()) return;

    if (stage !== 'cleanup' && trace.entries >= 11) return;
    trace.entries++;
    void logInfo('Renderer view work phase', {
        scope: 'renderer-navigation',
        extra: {
            releaseCheck: 'v1.3.6/renderer-view-work', rendererRun,
            navigationSequence: trace.navigationSequence, currentNavigationSequence: navigationSequence,
            activitySequence: trace.sequence, activity: trace.activity, stage,
            elapsedMs: Math.round(performance.now() - trace.startedAt),
            attachMode: details.attachMode, outcome: details.outcome,
            callbackCount: details.callbackCount, widthChangeCount: details.widthChangeCount,
            width: details.width, measured: details.measured, todayVisible: details.todayVisible, zoom: details.zoom,
            filteredCountBucket: details.filteredCount === undefined ? undefined : bucket(details.filteredCount),
            visibleCountBucket: details.visibleCount === undefined ? undefined : bucket(details.visibleCount),
            sequentialProjectCountBucket: details.sequentialProjectCount === undefined ? undefined : bucket(details.sequentialProjectCount),
            sequentialResultCountBucket: details.sequentialResultCount === undefined ? undefined : bucket(details.sequentialResultCount),
        },
    });
}

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


export function beginRendererNavigation(view: string): RendererNavigationTrace {
    const trace = {
        sequence: ++navigationSequence, previousView: committedView, nextView: safeView(view),
        startedAt: performance.now(), enabled: isLoggingEnabled(),
    };
    write(trace, 'requested');
    return trace;
}


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

        write(trace, 'animation-frame', actualView, state);
    });
    return () => { cancelled = true; cancelAnimationFrame(frame); };
}
