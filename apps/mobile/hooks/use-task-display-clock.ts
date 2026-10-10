import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

const listeners = new Set<() => void>();
let revision = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let appStateSubscription: ReturnType<typeof AppState.addEventListener> | undefined;
let active = true;

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
  if (!active || !listeners.size) return;
  // Core treats a timed due date as overdue strictly after its instant.
  timer = setTimeout(() => {
    refresh();
    schedule();
  }, 60_000 - (Date.now() % 60_000) + 1);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    active = AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
    appStateSubscription = AppState.addEventListener('change', (state) => {
      active = state === 'active';
      if (active) refresh();
      schedule();
    });
    refresh();
    schedule();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      stopTimer();
      appStateSubscription?.remove();
      appStateSubscription = undefined;
    }
  };
}

export function useTaskDisplayClock(enabled: boolean): number {
  return useSyncExternalStore(enabled ? subscribe : idleSubscribe, getSnapshot, getSnapshot);
}
