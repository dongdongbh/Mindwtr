import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logInfo, runStoreCommand, useTaskStore, type Task } from '@mindwtr/core';

import {
    DESKTOP_POMODORO_COLLAPSED_STORAGE_KEY,
    DESKTOP_POMODORO_SESSION_STORAGE_KEY,
    reconcilePomodoroSnapshot,
    usePomodoroStore,
} from './pomodoro-store';
import { armPomodoroCompletionSound } from '../lib/pomodoro-alert';
import { holdSyncSave } from '../test/hold-sync-save';

vi.mock('../lib/pomodoro-alert', () => ({
    armPomodoroCompletionSound: vi.fn(),
}));

// The store's durable save (core's flushPendingSave): each test may hold or fail it.
const flush = vi.hoisted(() => ({ impl: async () => undefined as void }));
vi.mock('@mindwtr/core', async (importOriginal) => ({
    ...await importOriginal<typeof import('@mindwtr/core')>(),
    flushPendingSave: () => flush.impl(),
    logInfo: vi.fn(),
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
        flush.impl = async () => undefined;
    });

    // A restart: the store reads the task as saved on disk, and the timer reads its stored session again.
    const restart = (savedTime: number | undefined, updates: Array<{ id: string; patch: Partial<Task> }>) => {
        useTaskStore.setState({
            tasks: [task({ timeSpentMinutes: savedTime })],
            _allTasks: [task({ timeSpentMinutes: savedTime })],
            updateTask: async (id: string, patch: Partial<Task>) => { updates.push({ id, patch }); },
        } as never);
        usePomodoroStore.setState({ hasHydrated: false });
        usePomodoroStore.getState().hydratePomodoro({});
    };

    it('credits once when the app quit before the task save landed', async () => {
        const updates: Array<{ id: string; patch: Partial<Task> }> = [];
        useTaskStore.setState({
            updateTask: async (id: string, patch: Partial<Task>) => { updates.push({ id, patch }); },
        } as never);
        flush.impl = () => new Promise<void>(() => undefined);
        seedRunningSession({ selectedTaskId: 'task-1', focusMinutes: 25 });

        usePomodoroStore.getState().hydratePomodoro({});
        await vi.waitFor(() => expect(updates).toHaveLength(1));

        // The app quits with the task's save in flight: the disk still holds no time.
        flush.impl = async () => undefined;
        const after: Array<{ id: string; patch: Partial<Task> }> = [];
        restart(undefined, after);
        await vi.waitFor(() => expect(after).toEqual([{ id: 'task-1', patch: { timeSpentMinutes: 25 } }]));
        // Settled: a third start owes nothing.
        await vi.waitFor(() => expect(JSON.parse(window.localStorage.getItem(DESKTOP_POMODORO_SESSION_STORAGE_KEY)!).pendingCredits).toBeUndefined());
        const third: Array<{ id: string; patch: Partial<Task> }> = [];
        restart(25, third);
        await Promise.resolve();
        expect(third).toEqual([]);
    });

    it('retries a task save that failed without adding the time twice', async () => {
        const updates: Array<{ id: string; patch: Partial<Task> }> = [];
        useTaskStore.setState({
            updateTask: async (id: string, patch: Partial<Task>) => {
                updates.push({ id, patch });
                const current = useTaskStore.getState().tasks;
                useTaskStore.setState({ tasks: current.map((row) => (row.id === id ? { ...row, ...patch } : row)) } as never);
            },
        } as never);
        let failed = 0;
        flush.impl = async () => { failed += 1; throw new Error('disk full'); };
        seedRunningSession({ selectedTaskId: 'task-1', focusMinutes: 25 });

        usePomodoroStore.getState().hydratePomodoro({});
        await vi.waitFor(() => expect(failed).toBe(1));
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
        expect(updates).toHaveLength(1);
        expect(JSON.parse(window.localStorage.getItem(DESKTOP_POMODORO_SESSION_STORAGE_KEY)!).pendingCredits)
            .toEqual([{ taskId: 'task-1', to: 25 }]);

        // The next commit settles again: the time is already in memory, so only the save is retried.
        let saves = 0;
        flush.impl = async () => { saves += 1; };
        usePomodoroStore.getState().commitPomodoro((prev) => ({ ...prev, selectedTaskId: 'task-1', updatedAtMs: Date.now() }));
        await vi.waitFor(() => expect(JSON.parse(window.localStorage.getItem(DESKTOP_POMODORO_SESSION_STORAGE_KEY)!).pendingCredits).toBeUndefined());
        expect(updates).toEqual([{ id: 'task-1', patch: { timeSpentMinutes: 25 } }]);
        expect(saves).toBe(1);
    });

    it('leaves a credit owed from before a restart when the task\'s time moved since', async () => {
        // It was given (and synced on) before the quit, or another device changed the task: either way, not again.
        window.localStorage.setItem(DESKTOP_POMODORO_SESSION_STORAGE_KEY, JSON.stringify({
            durations: { focusMinutes: 25, breakMinutes: 5 },
            timerState: { phase: 'break', remainingSeconds: 300, isRunning: false, completedFocusSessions: 1 },
            selectedTaskId: 'task-1',
            updatedAtMs: Date.now(),
            sessionHistory: { totalCompletedFocusSessions: 1, completedFocusSessionsByTaskId: { 'task-1': 1 } },
            pendingCredits: [{ taskId: 'task-1', from: 5, to: 30 }],
        }));
        const updates: Array<{ id: string; patch: Partial<Task> }> = [];
        restart(42, updates);
        await vi.waitFor(() => expect(JSON.parse(window.localStorage.getItem(DESKTOP_POMODORO_SESSION_STORAGE_KEY)!).pendingCredits).toBeUndefined());
        expect(updates).toEqual([]);
    });

    it('credits each session once when the panel hydrates again while a credit waits for its save', async () => {
        useTaskStore.setState({
            tasks: [task({ timeSpentMinutes: 5 })],
            _allTasks: [task({ timeSpentMinutes: 5 })],
            updateTask: async (id: string, patch: Partial<Task>) => {
                const current = useTaskStore.getState().tasks;
                useTaskStore.setState({ tasks: current.map((row) => (row.id === id ? { ...row, ...patch } : row)) } as never);
            },
        } as never);
        // One credit owed from before (5 to 30), and one focus session that finished while the app was closed.
        window.localStorage.setItem(DESKTOP_POMODORO_SESSION_STORAGE_KEY, JSON.stringify({
            durations: { focusMinutes: 25, breakMinutes: 5 },
            timerState: { phase: 'focus', remainingSeconds: 5, isRunning: true, completedFocusSessions: 1 },
            selectedTaskId: 'task-1',
            updatedAtMs: Date.now() - 10_000,
            sessionHistory: { totalCompletedFocusSessions: 1, completedFocusSessionsByTaskId: { 'task-1': 1 } },
            pendingCredits: [{ taskId: 'task-1', from: 5, to: 30 }],
        }));
        let release!: () => void;
        let saves = 0;
        flush.impl = () => { saves += 1; return saves === 1 ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve(); };

        usePomodoroStore.getState().hydratePomodoro({});
        await vi.waitFor(() => expect(saves).toBe(1));
        // The Agenda's Pomodoro panel mounts and hydrates while the first save still waits.
        usePomodoroStore.getState().hydratePomodoro({});
        await vi.waitFor(() => expect(saves).toBeGreaterThanOrEqual(2));
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
        release();
        for (let i = 0; i < 50; i += 1) await Promise.resolve();
        expect(useTaskStore.getState().tasks[0].timeSpentMinutes).toBe(55);
    });

    it('stores a credit chained from a moved one at its moved time, so a quit before its save credits it once', async () => {
        useTaskStore.setState({
            tasks: [task({ timeSpentMinutes: 12 })],
            _allTasks: [task({ timeSpentMinutes: 12 })],
            updateTask: async (id: string, patch: Partial<Task>) => {
                const current = useTaskStore.getState().tasks;
                useTaskStore.setState({ tasks: current.map((row) => (row.id === id ? { ...row, ...patch } : row)) } as never);
            },
        } as never);
        // A stored credit (5 to 30) was overtaken: the task is at 12. A focus that ended while closed (B) chains from it.
        window.localStorage.setItem(DESKTOP_POMODORO_SESSION_STORAGE_KEY, JSON.stringify({
            durations: { focusMinutes: 25, breakMinutes: 5 },
            timerState: { phase: 'focus', remainingSeconds: 5, isRunning: true, completedFocusSessions: 1 },
            selectedTaskId: 'task-1',
            updatedAtMs: Date.now() - 10_000,
            sessionHistory: { totalCompletedFocusSessions: 1, completedFocusSessionsByTaskId: { 'task-1': 1 } },
            pendingCredits: [{ taskId: 'task-1', from: 5, to: 30 }],
        }));
        usePomodoroStore.getState().hydratePomodoro({});
        // Another session (C) finishes before B settles, so it chains from B.
        usePomodoroStore.getState().commitPomodoro((prev) => ({ ...prev, sessionHistory: { ...prev.sessionHistory,
            totalCompletedFocusSessions: prev.sessionHistory.totalCompletedFocusSessions + 1,
            completedFocusSessionsByTaskId: { 'task-1': (prev.sessionHistory.completedFocusSessionsByTaskId['task-1'] ?? 0) + 1 } } }));
        // B lands and leaves the session; the app quits before C is given.
        await vi.waitFor(() => expect(JSON.parse(window.localStorage.getItem(DESKTOP_POMODORO_SESSION_STORAGE_KEY)!).pendingCredits)
            .toEqual([{ taskId: 'task-1', from: 37, to: 62 }]));
        expect(useTaskStore.getState().tasks[0].timeSpentMinutes).toBe(37);
        expect(logInfo).toHaveBeenCalledWith('Pomodoro credit moved onto the task time', {
            scope: 'pomodoro', context: { releaseCheck: 'v1.3.8/pomodoro-credit-moved', outcome: 'moved' } });
        const updates: Array<{ id: string; patch: Partial<Task> }> = [];
        restart(37, updates);
        await vi.waitFor(() => expect(updates).toEqual([{ id: 'task-1', patch: { timeSpentMinutes: 62 } }]));
    });

    it('stores a credit moved by a sync save before giving it, so a quit then credits it once', async () => {
        const updates: Array<{ id: string; patch: Partial<Task> }> = [];
        useTaskStore.setState({
            tasks: [task({ timeSpentMinutes: 50 })],
            _allTasks: [task({ timeSpentMinutes: 50 })],
            updateTask: (id: string, patch: Partial<Task>) => runStoreCommand(async () => { updates.push({ id, patch }); }),
        } as never);
        flush.impl = () => new Promise<void>(() => undefined);
        seedRunningSession({ selectedTaskId: 'task-1', focusMinutes: 25 });
        const finish = holdSyncSave(() => useTaskStore.setState({ tasks: [task({ timeSpentMinutes: 60 })] } as never));

        usePomodoroStore.getState().hydratePomodoro({});
        await finish();
        await vi.waitFor(() => expect(updates).toEqual([{ id: 'task-1', patch: { timeSpentMinutes: 85 } }]));
        expect(JSON.parse(window.localStorage.getItem(DESKTOP_POMODORO_SESSION_STORAGE_KEY)!).pendingCredits)
            .toEqual([{ taskId: 'task-1', from: 60, to: 85 }]);
    });

    it('retries the save of a written credit when the panel hydrates again, and keeps it owed while saves fail', async () => {
        const updates: Array<{ id: string; patch: Partial<Task> }> = [];
        useTaskStore.setState({
            updateTask: async (id: string, patch: Partial<Task>) => {
                updates.push({ id, patch });
                const current = useTaskStore.getState().tasks;
                useTaskStore.setState({ tasks: current.map((row) => (row.id === id ? { ...row, ...patch } : row)) } as never);
            },
        } as never);
        let failed = 0;
        flush.impl = async () => { failed += 1; throw new Error('disk full'); };
        seedRunningSession({ selectedTaskId: 'task-1', focusMinutes: 25 });

        usePomodoroStore.getState().hydratePomodoro({});
        await vi.waitFor(() => expect(failed).toBe(1));
        usePomodoroStore.getState().hydratePomodoro({});
        await vi.waitFor(() => expect(failed).toBe(2));
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
        expect(updates).toHaveLength(1);
        expect(JSON.parse(window.localStorage.getItem(DESKTOP_POMODORO_SESSION_STORAGE_KEY)!).pendingCredits)
            .toEqual([{ taskId: 'task-1', to: 25 }]);
    });

    it('keeps a credit owed when the store gave up on its save, though the next flush resolves', async () => {
        useTaskStore.setState({
            updateTask: async (id: string, patch: Partial<Task>) => {
                const current = useTaskStore.getState().tasks;
                // The store's save fails for good: it records the failure and drops the save.
                useTaskStore.setState({
                    tasks: current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
                    persistenceFailure: { message: 'disk full', at: Date.now() },
                } as never);
            },
        } as never);
        seedRunningSession({ selectedTaskId: 'task-1', focusMinutes: 25 });
        try {
            usePomodoroStore.getState().hydratePomodoro({});
            await vi.waitFor(() => expect(useTaskStore.getState().tasks[0].timeSpentMinutes).toBe(25));
            for (let i = 0; i < 10; i += 1) await Promise.resolve();
            expect(JSON.parse(window.localStorage.getItem(DESKTOP_POMODORO_SESSION_STORAGE_KEY)!).pendingCredits)
                .toEqual([{ taskId: 'task-1', to: 25 }]);
        } finally {
            useTaskStore.setState({ persistenceFailure: null } as never);
        }
    });

    it('does not credit twice when the session could not be saved', async () => {
        const updates: Array<{ id: string; patch: Partial<Task> }> = [];
        useTaskStore.setState({
            updateTask: async (id: string, patch: Partial<Task>) => { updates.push({ id, patch }); },
        } as never);
        seedRunningSession({ selectedTaskId: 'task-1', focusMinutes: 25 });
        vi.mocked(window.localStorage.setItem).mockImplementation(() => { throw new Error('quota exceeded'); });

        usePomodoroStore.getState().hydratePomodoro({});
        await Promise.resolve();
        await Promise.resolve();

        // The stored session still shows the finished phase, so the next start credits it: this start must not.
        expect(updates).toEqual([]);
        vi.mocked(window.localStorage.setItem).mockRestore();
        const after: Array<{ id: string; patch: Partial<Task> }> = [];
        restart(undefined, after);
        await vi.waitFor(() => expect(after).toEqual([{ id: 'task-1', patch: { timeSpentMinutes: 25 } }]));
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

    it('adds to the total a sync save published while the credit waited', async () => {
        const updates: Array<{ id: string; patch: Partial<Task> }> = [];
        useTaskStore.setState({
            tasks: [task({ timeSpentMinutes: 50 })],
            _allTasks: [task({ timeSpentMinutes: 50 })],
            // A store command, as the real updateTask is: it waits for the save.
            updateTask: (id: string, patch: Partial<Task>) => runStoreCommand(async () => { updates.push({ id, patch }); }),
        } as never);
        seedRunningSession({ selectedTaskId: 'task-1', focusMinutes: 25 });
        // Another device logged time on the task; the sync save publishes it.
        const finish = holdSyncSave(() => useTaskStore.setState({ tasks: [task({ timeSpentMinutes: 60 })] } as never));

        usePomodoroStore.getState().hydratePomodoro({});
        await finish();
        await vi.waitFor(() => expect(updates).toHaveLength(1));

        expect(updates).toEqual([{ id: 'task-1', patch: { timeSpentMinutes: 85 } }]);
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
