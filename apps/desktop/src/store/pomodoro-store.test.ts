import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore, type Task } from '@mindwtr/core';

import {
    DESKTOP_POMODORO_COLLAPSED_STORAGE_KEY,
    DESKTOP_POMODORO_SESSION_STORAGE_KEY,
    reconcilePomodoroSnapshot,
    usePomodoroStore,
} from './pomodoro-store';
import { armPomodoroCompletionSound } from '../lib/pomodoro-alert';

vi.mock('../lib/pomodoro-alert', () => ({
    armPomodoroCompletionSound: vi.fn(),
}));

const NOW_ISO = new Date().toISOString();

const task = (updates: Partial<Task> = {}): Task => ({
    id: 'task-1',
    title: 'Write report',
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...updates,
});

const seedRunningSession = (options: {
    selectedTaskId?: string;
    focusMinutes?: number;
    remainingSeconds?: number;
    updatedAtMs?: number;
}) => {
    const focusMinutes = options.focusMinutes ?? 25;
    window.localStorage.setItem(DESKTOP_POMODORO_SESSION_STORAGE_KEY, JSON.stringify({
        durations: { focusMinutes, breakMinutes: 5 },
        timerState: {
            phase: 'focus',
            remainingSeconds: options.remainingSeconds ?? 5,
            isRunning: true,
            completedFocusSessions: 0,
        },
        selectedTaskId: options.selectedTaskId,
        updatedAtMs: options.updatedAtMs ?? Date.now() - 10_000,
        sessionHistory: { totalCompletedFocusSessions: 0, completedFocusSessionsByTaskId: {} },
    }));
};

let writeCount = 0;

describe('pomodoro store', () => {
    beforeEach(() => {
        window.localStorage.clear();
        writeCount = 0;
        const originalSetItem = window.localStorage.setItem.bind(window.localStorage);
        vi.spyOn(window.localStorage, 'setItem').mockImplementation((key: string, value: string) => {
            if (key === DESKTOP_POMODORO_SESSION_STORAGE_KEY) writeCount += 1;
            originalSetItem(key, value);
        });
        useTaskStore.setState({ tasks: [task()], _allTasks: [task()] } as never);
        usePomodoroStore.setState({ hasHydrated: false, collapsed: false });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('credits a focus session completed while the app was closed to the linked task', () => {
        const updates: Array<{ id: string; patch: Partial<Task> }> = [];
        useTaskStore.setState({
            updateTask: async (id: string, patch: Partial<Task>) => {
                updates.push({ id, patch });
            },
        } as never);
        seedRunningSession({ selectedTaskId: 'task-1', focusMinutes: 25 });

        usePomodoroStore.getState().hydratePomodoro({});

        expect(updates).toEqual([{ id: 'task-1', patch: { timeSpentMinutes: 25 } }]);
        const history = usePomodoroStore.getState().snapshot.sessionHistory;
        expect(history.completedFocusSessionsByTaskId['task-1']).toBe(1);
    });

    it('adds to an existing time-spent total instead of replacing it', () => {
        const updates: Array<{ id: string; patch: Partial<Task> }> = [];
        useTaskStore.setState({
            tasks: [task({ timeSpentMinutes: 50 })],
            _allTasks: [task({ timeSpentMinutes: 50 })],
            updateTask: async (id: string, patch: Partial<Task>) => {
                updates.push({ id, patch });
            },
        } as never);
        seedRunningSession({ selectedTaskId: 'task-1', focusMinutes: 25 });

        usePomodoroStore.getState().hydratePomodoro({});

        expect(updates).toEqual([{ id: 'task-1', patch: { timeSpentMinutes: 75 } }]);
    });

    it('does not touch tasks when the completed session has no linked task', () => {
        const updates: Array<{ id: string; patch: Partial<Task> }> = [];
        useTaskStore.setState({
            updateTask: async (id: string, patch: Partial<Task>) => {
                updates.push({ id, patch });
            },
        } as never);
        seedRunningSession({ focusMinutes: 25 });

        usePomodoroStore.getState().hydratePomodoro({});

        expect(updates).toEqual([]);
        expect(usePomodoroStore.getState().snapshot.sessionHistory.totalCompletedFocusSessions).toBe(1);
    });

    // The Start click is the only moment WebKit lets an audible AudioContext be
    // created, so every stopped→running commit must arm the chime (#528).
    it('arms the completion chime on the stopped-to-running transition only', () => {
        vi.mocked(armPomodoroCompletionSound).mockClear();
        usePomodoroStore.getState().hydratePomodoro({});
        usePomodoroStore.getState().commitPomodoro((prev) => ({
            ...prev,
            timerState: { ...prev.timerState, isRunning: true },
            updatedAtMs: Date.now(),
        }));
        expect(armPomodoroCompletionSound).toHaveBeenCalledTimes(1);

        // A running-to-running tick is not a gesture; no re-arm.
        usePomodoroStore.getState().commitPomodoro((prev) => ({
            ...prev,
            timerState: { ...prev.timerState, remainingSeconds: prev.timerState.remainingSeconds - 1 },
            updatedAtMs: Date.now(),
        }));
        expect(armPomodoroCompletionSound).toHaveBeenCalledTimes(1);
    });

    it('starts a linked focus session from a task via quick start', () => {
        usePomodoroStore.getState().hydratePomodoro({});
        usePomodoroStore.getState().startPomodoroFocusForTask('task-1', {});

        const snapshot = usePomodoroStore.getState().snapshot;
        expect(snapshot.selectedTaskId).toBe('task-1');
        expect(snapshot.timerState.phase).toBe('focus');
        expect(snapshot.timerState.isRunning).toBe(true);

        const stored = JSON.parse(window.localStorage.getItem(DESKTOP_POMODORO_SESSION_STORAGE_KEY) ?? '{}');
        expect(stored.selectedTaskId).toBe('task-1');
        expect(stored.timerState.isRunning).toBe(true);
    });

    it('hydrates lazily when quick start is the first pomodoro interaction', () => {
        seedRunningSession({ selectedTaskId: undefined, focusMinutes: 25, remainingSeconds: 120 });

        usePomodoroStore.getState().startPomodoroFocusForTask('task-1', {});

        const snapshot = usePomodoroStore.getState().snapshot;
        expect(snapshot.selectedTaskId).toBe('task-1');
        expect(snapshot.timerState.isRunning).toBe(true);
        expect(snapshot.durations.focusMinutes).toBe(25);
    });

    it('skips the storage write for a plain countdown tick but restores the same clock', () => {
        seedRunningSession({ selectedTaskId: 'task-1', focusMinutes: 25, remainingSeconds: 300, updatedAtMs: Date.now() });
        usePomodoroStore.getState().hydratePomodoro({});
        const writesAfterHydrate = writeCount;
        const hydratedAtMs = usePomodoroStore.getState().snapshot.updatedAtMs;

        // Ten seconds of ticking, once per second.
        for (let second = 1; second <= 10; second += 1) {
            usePomodoroStore.getState().commitPomodoro((prev) => reconcilePomodoroSnapshot(prev, hydratedAtMs + second * 1000, {}));
        }
        expect(usePomodoroStore.getState().snapshot.timerState.remainingSeconds).toBe(290);
        expect(writeCount).toBe(writesAfterHydrate);

        // The stale stored pair still reconstructs the live clock exactly.
        usePomodoroStore.setState({ hasHydrated: false });
        const stored = JSON.parse(window.localStorage.getItem(DESKTOP_POMODORO_SESSION_STORAGE_KEY) ?? '{}');
        const elapsed = Math.floor((hydratedAtMs + 10_000 - stored.updatedAtMs) / 1000);
        expect(stored.timerState.remainingSeconds - elapsed).toBe(290);

        // Pausing is a state transition, so it persists immediately.
        usePomodoroStore.getState().commitPomodoro((prev) => ({
            ...prev,
            timerState: { ...prev.timerState, isRunning: false },
        }));
        expect(writeCount).toBe(writesAfterHydrate + 1);
    });

    it('persists the collapsed preference to its own local-storage key', () => {
        usePomodoroStore.getState().setPomodoroCollapsed(true);

        expect(usePomodoroStore.getState().collapsed).toBe(true);
        expect(window.localStorage.getItem(DESKTOP_POMODORO_COLLAPSED_STORAGE_KEY)).toBe('true');

        usePomodoroStore.getState().setPomodoroCollapsed(false);

        expect(usePomodoroStore.getState().collapsed).toBe(false);
        expect(window.localStorage.getItem(DESKTOP_POMODORO_COLLAPSED_STORAGE_KEY)).toBe('false');
    });

    it('un-collapses the panel when a task quick-starts its timer', () => {
        usePomodoroStore.getState().setPomodoroCollapsed(true);
        expect(usePomodoroStore.getState().collapsed).toBe(true);

        usePomodoroStore.getState().startPomodoroFocusForTask('task-1', {});

        expect(usePomodoroStore.getState().collapsed).toBe(false);
        expect(window.localStorage.getItem(DESKTOP_POMODORO_COLLAPSED_STORAGE_KEY)).toBe('false');
    });
});
