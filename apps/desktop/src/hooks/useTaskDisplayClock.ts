import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
let revision = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

const getSnapshot = () => revision;
const idleSubscribe = () => () => {};

function stopTimer() {
    clearTimeout(timer);
    timer = undefined;
}

function refresh() {
    revision += 1;
    listeners.forEach((listener) => listener());
}

function schedule() {
    stopTimer();
    if (document.hidden || !listeners.size) return;
    // Core treats a timed due date as overdue strictly after its instant.
    timer = setTimeout(() => {
        refresh();
        schedule();
    }, 60_000 - (Date.now() % 60_000) + 1);
}

function onVisibilityChange() {
    if (!document.hidden) refresh();
    schedule();
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    if (listeners.size === 1) {
        document.addEventListener('visibilitychange', onVisibilityChange);
        refresh();
        schedule();
    }
    return () => {
        listeners.delete(listener);
        if (!listeners.size) {
            stopTimer();
            document.removeEventListener('visibilitychange', onVisibilityChange);
        }
    };
}

export function useTaskDisplayClock(enabled: boolean): number {
    return useSyncExternalStore(enabled ? subscribe : idleSubscribe, getSnapshot, getSnapshot);
}
